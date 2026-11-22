import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { callInviteEmail, firstName, gmailDraftUrl } from '../src/emails.js';
import { newApplication, recordCallInvite, setStatus } from '../src/applications.js';
import { ADMIN, OUTSIDER, SECOND_ADMIN, boot, valid } from './helpers.js';

const only = async (app) => (await app.store.list())[0];
const made = (over = {}) => newApplication({ ...valid(), linkedinUrl: 'https://linkedin.com/in/test-applicant', ...over }, '2026-11-19T15:00:00.000Z', '0b0f6c1e-3b1a-4c53-9d4e-2f6a1c7d8e90');

// ---------- the stage ----------

test('the call is a stage between pending and a decision, recorded with who and when', async () => {
  const app = await boot();
  await app.apply(valid());
  const id = (await only(app)).id;
  const first = app.cookieFor(ADMIN);
  const second = app.cookieFor(SECOND_ADMIN);
  const post = async (cookie, path, body) => {
    const res = await app.call('POST', `/api/applications/${id}/${path}`, { cookie, body });
    return { status: res.status, body: await res.json() };
  };

  assert.deepEqual((await only(app)).call, { inviteSentBy: null, inviteSentAt: null });

  // A call invite cannot be recorded for an application that is not at the call stage.
  let r = await post(first, 'call', { action: 'sent' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'not_at_call_stage');

  app.clock.t += 60_000;
  r = await post(first, 'status', { status: 'call' });
  assert.equal(r.status, 200);
  assert.equal(r.body.application.status, 'call');
  assert.deepEqual(r.body.application.review, { by: ADMIN, at: '2026-11-19T15:01:00.000Z' });

  // Being at the call stage grants nothing: no Slack invitation can be recorded.
  r = await post(first, 'invitation', { action: 'sent' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'not_approved');

  app.clock.t += 60_000;
  r = await post(second, 'call', { action: 'sent' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.application.call, { inviteSentBy: SECOND_ADMIN, inviteSentAt: '2026-11-19T15:02:00.000Z' });
  assert.equal(r.body.application.status, 'call', 'recording the invite decides nothing');
  assert.equal((await post(first, 'call', { action: 'sent' })).status, 409, 'not twice');
  assert.equal((await post(first, 'call', { action: 'banana' })).status, 400);

  r = await post(first, 'call', { action: 'clear' });
  assert.deepEqual(r.body.application.call, { inviteSentBy: null, inviteSentAt: null });
  assert.equal((await post(first, 'call', { action: 'clear' })).status, 200, 'clearing twice is harmless');
  await post(first, 'call', { action: 'sent' });

  // After the call: notes, then a decision. The invitation only unlocks on approval.
  await post(first, 'notes', { text: 'Wants to meet trial operators. Founding soon.' });
  app.clock.t += 60_000;
  r = await post(second, 'status', { status: 'approved' });
  assert.equal(r.body.application.status, 'approved');
  assert.deepEqual(r.body.application.review, { by: SECOND_ADMIN, at: '2026-11-19T15:03:00.000Z' });
  assert.equal(r.body.application.call.inviteSentBy, ADMIN, 'the call invite record is kept');
  assert.equal(r.body.application.invitation.status, 'not_sent', 'approval after a call still invites nobody');
  assert.equal((await post(first, 'call', { action: 'sent' })).status, 409, 'no new call invite once decided');
  assert.equal((await post(first, 'invitation', { action: 'sent' })).status, 200);

  const doc = await only(app);
  assert.deepEqual(doc.answers, { ...valid(), linkedinUrl: 'https://linkedin.com/in/test-applicant' }, 'answers never change');
  assert.deepEqual(doc.history.map((e) => [e.by, e.action, e.to || '']), [
    ['applicant', 'submitted', ''],
    [ADMIN, 'status', 'call'],
    [SECOND_ADMIN, 'call_invite', 'sent'],
    [ADMIN, 'call_invite', 'not_sent'],
    [ADMIN, 'call_invite', 'sent'],
    [ADMIN, 'notes', ''],
    [SECOND_ADMIN, 'status', 'approved'],
    [ADMIN, 'invitation', 'sent'],
  ]);
  assert.ok(app.logs.some((l) => l.includes('"application.call_invite"')));
  await app.close();
});

test('the call can be skipped, and a call can end in a decline', async () => {
  const app = await boot();
  await app.apply(valid());
  await app.apply(valid({ email: 'second@example.org' }));
  const [a, b] = await app.store.list();
  const cookie = app.cookieFor(ADMIN);
  const status = (id, to) => app.call('POST', `/api/applications/${id}/status`, { cookie, body: { status: to } });

  assert.equal((await status(a.id, 'approved')).status, 200);
  assert.equal((await app.store.get(a.id)).status, 'approved');

  await status(b.id, 'call');
  await status(b.id, 'declined');
  assert.equal((await app.store.get(b.id)).status, 'declined');
  await status(b.id, 'pending');
  assert.equal((await app.store.get(b.id)).status, 'pending');
  await app.close();
});

test('only signed-in reviewers can move an application to a call or record the invite', async () => {
  const app = await boot();
  await app.apply(valid());
  const id = (await only(app)).id;
  const attempts = [
    {},
    { cookie: app.cookieFor(OUTSIDER) },
    { cookie: app.cookieFor(ADMIN), review: false },
    { cookie: app.cookieFor(ADMIN), headers: { Origin: 'https://evil.example' } },
  ];
  for (const attempt of attempts) {
    for (const [path, body] of [['status', { status: 'call' }], ['call', { action: 'sent' }]]) {
      const res = await app.call('POST', `/api/applications/${id}/${path}`, { body, ...attempt });
      assert.ok([401, 403].includes(res.status), `${path} ${JSON.stringify(Object.keys(attempt))} -> ${res.status}`);
    }
  }
  const doc = await only(app);
  assert.equal(doc.status, 'pending');
  assert.equal(doc.history.length, 1);
  await app.close();
});

test('an applicant cannot put themselves at the call stage', async () => {
  const app = await boot();
  await app.apply(valid({ status: 'call', call: { inviteSentBy: 'me', inviteSentAt: '2026-01-01T00:00:00.000Z' } }));
  const doc = await only(app);
  assert.equal(doc.status, 'pending');
  assert.deepEqual(doc.call, { inviteSentBy: null, inviteSentAt: null });
  await app.close();
});

test('an application saved before the call stage existed still works', async () => {
  const app = await boot();
  const old = made();
  delete old.call;
  await app.store.create(old);
  const cookie = app.cookieFor(ADMIN);
  const list = await (await app.call('GET', '/api/applications', { cookie })).json();
  assert.deepEqual(list.applications[0].call, { inviteSentBy: null, inviteSentAt: null });
  await app.call('POST', `/api/applications/${old.id}/status`, { cookie, body: { status: 'call' } });
  const res = await app.call('POST', `/api/applications/${old.id}/call`, { cookie, body: { action: 'sent' } });
  assert.equal(res.status, 200);
  assert.equal((await app.store.get(old.id)).call.inviteSentBy, ADMIN);
  await app.close();
});

test('the rules alone: a call invite needs the call stage', () => {
  const app = made();
  assert.throws(() => recordCallInvite(app, 'sent', ADMIN, '2026-11-19T15:01:00.000Z'), { code: 'not_at_call_stage' });
  setStatus(app, 'call', ADMIN, '2026-11-19T15:01:00.000Z');
  recordCallInvite(app, 'sent', ADMIN, '2026-11-19T15:02:00.000Z');
  assert.throws(() => recordCallInvite(app, 'sent', ADMIN, '2026-11-19T15:03:00.000Z'), { code: 'already_recorded' });
  assert.throws(() => recordCallInvite(app, 'joined', ADMIN, '2026-11-19T15:03:00.000Z'), { code: 'invalid_action' });
  assert.throws(() => setStatus(app, 'interview', ADMIN, '2026-11-19T15:03:00.000Z'), { code: 'invalid_status' });
});

// ---------- the invite email ----------

test('the review page gets a ready-to-send Gmail draft for the call invite', async () => {
  const app = await boot();
  await app.apply(valid({ fullName: 'Jane Okafor-Smith', email: 'jane+bio@example.org' }));
  const cookie = app.cookieFor(SECOND_ADMIN);
  const list = await (await app.call('GET', '/api/applications', { cookie })).json();
  const url = new URL(list.applications[0].callInviteUrl);
  assert.equal(url.origin + url.pathname, 'https://mail.google.com/mail/');
  assert.equal(url.searchParams.get('view'), 'cm');
  assert.equal(url.searchParams.get('to'), 'jane+bio@example.org');
  assert.equal(url.searchParams.get('authuser'), SECOND_ADMIN, 'opens in the signed-in reviewer\'s own Gmail');
  assert.equal(url.searchParams.get('su'), 'Homology | quick intro call');
  const body = url.searchParams.get('body');
  assert.match(body, /^Hi Jane,\n\nThanks for applying to Homology\./);
  assert.match(body, /Send over a couple of times that work/);
  assert.ok(!body.includes('http'), 'no link until a booking link is set');
  assert.ok(body.endsWith('\n\nAdarsh and Arthur'));
  assert.ok(!body.includes('—'), 'no em dashes');

  // The same link comes back after a change, for whoever made it.
  const id = list.applications[0].id;
  const changed = await (await app.call('POST', `/api/applications/${id}/status`, { cookie: app.cookieFor(ADMIN), body: { status: 'call' } })).json();
  assert.equal(new URL(changed.application.callInviteUrl).searchParams.get('authuser'), ADMIN);

  const config = await (await fetch(app.base + '/api/config')).json();
  assert.deepEqual(config.call, { bookingLinkSet: false });
  await app.close();
});

test('setting CALL_BOOKING_URL is all it takes to put the booking link in the invite', async () => {
  const app = await boot({ CALL_BOOKING_URL: ' https://cal.example.org/homology/intro ' });
  await app.apply(valid());
  const list = await (await app.call('GET', '/api/applications', { cookie: app.cookieFor(ADMIN) })).json();
  const body = new URL(list.applications[0].callInviteUrl).searchParams.get('body');
  assert.match(body, /Do you have 15 minutes for a quick call\? You can pick a time here:\nhttps:\/\/cal\.example\.org\/homology\/intro\n/);
  assert.ok(!body.includes('couple of times'));
  const config = await (await fetch(app.base + '/api/config')).json();
  assert.deepEqual(config.call, { bookingLinkSet: true });
  await app.close();
});

test('a booking link must be a plain https link', () => {
  const base = { ADMIN_EMAILS: ADMIN };
  assert.deepEqual(loadConfig({ ...base, CALL_BOOKING_URL: 'https://cal.com/someone/intro' }).problems, []);
  assert.deepEqual(loadConfig(base).problems, []);
  for (const bad of ['http://cal.com/x', 'javascript:alert(1)', 'cal.com/x', 'https://user:pw@cal.com/x', 'not a link']) {
    assert.match(loadConfig({ ...base, CALL_BOOKING_URL: bad }).problems.join(' '), /CALL_BOOKING_URL must be an https link/, bad);
  }
});

test('the greeting uses a first name only when there clearly is one', () => {
  assert.equal(firstName('Jane Smith'), 'Jane');
  assert.equal(firstName('  María-José   Carreño '), 'María-José');
  assert.equal(firstName("O'Neil Brown"), "O'Neil");
  assert.equal(firstName('李 雷'), '');
  assert.equal(firstName('Dr. Jane Smith'), '');
  assert.equal(firstName('J Smith'), '');
  assert.equal(firstName('<!channel> *Urgent*'), '');
  assert.equal(firstName('jane99 x'), '');
  assert.equal(firstName(''), '');
  assert.match(callInviteEmail(made({ fullName: 'Dr. Jane Smith' })).body, /^Hi there,\n/);
  assert.match(callInviteEmail(made({ fullName: 'Li Wei' })).body, /^Hi Li,\n/);
});

test('whatever an applicant typed stays inside the draft link as data', () => {
  const hostile = made({ fullName: 'Eve&to=boss@example.org Smith', email: 'eve&bcc=all@example.org' });
  const link = gmailDraftUrl(callInviteEmail(hostile), { authuser: ADMIN });
  const url = new URL(link);
  assert.equal(url.hostname, 'mail.google.com');
  assert.deepEqual([...url.searchParams.keys()], ['authuser', 'view', 'fs', 'to', 'su', 'body']);
  assert.equal(url.searchParams.get('to'), 'eve&bcc=all@example.org');
  assert.equal(url.searchParams.get('bcc'), null);
  assert.ok(!/[\n\r<> ]/.test(link), 'fully encoded');
  assert.ok(link.length < 3000, 'fits in a Slack button');
  const longest = made({ fullName: `${'A'.repeat(40)} ${'b'.repeat(79)}`, email: `${'e'.repeat(240)}@example.org` });
  assert.ok(gmailDraftUrl(callInviteEmail(longest, { bookingUrl: 'https://cal.com/homology/a-rather-long-booking-link-name' })).length < 3000);
});
