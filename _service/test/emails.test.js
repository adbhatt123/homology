import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callInviteEmail, declineEmail, draftUrls, welcomeEmail } from '../src/emails.js';
import { newApplication, recordDecisionEmail, setStatus } from '../src/applications.js';
import { ADMIN, OUTSIDER, SECOND_ADMIN, boot, valid } from './helpers.js';

const only = async (app) => (await app.store.list())[0];
const made = (over = {}) => newApplication({ ...valid(), linkedinUrl: 'https://linkedin.com/in/test-applicant', ...over }, '2026-11-19T15:00:00.000Z', '0b0f6c1e-3b1a-4c53-9d4e-2f6a1c7d8e90');
const NONE = { welcome: { sentBy: null, sentAt: null }, decline: { sentBy: null, sentAt: null } };

// ---------- recording ----------

test('a welcome email belongs to an approval and a decline email to a decline', async () => {
  const app = await boot();
  await app.apply(valid());
  const id = (await only(app)).id;
  const first = app.cookieFor(ADMIN);
  const second = app.cookieFor(SECOND_ADMIN);
  const post = async (cookie, path, body) => {
    const res = await app.call('POST', `/api/applications/${id}/${path}`, { cookie, body });
    return { status: res.status, body: await res.json() };
  };
  assert.deepEqual((await only(app)).emails, NONE);

  // Nothing can be recorded before a decision, or at the call stage.
  for (const status of ['pending', 'call']) {
    if (status !== 'pending') await post(first, 'status', { status });
    for (const kind of ['welcome', 'decline']) {
      const r = await post(first, 'email', { kind, action: 'sent' });
      assert.equal(r.status, 409, `${kind} while ${status}`);
      assert.equal(r.body.error, 'wrong_status');
    }
  }
  assert.deepEqual((await only(app)).emails, NONE);

  // Declined: only the decline email.
  await post(first, 'status', { status: 'declined' });
  assert.equal((await post(first, 'email', { kind: 'welcome', action: 'sent' })).status, 409);
  app.clock.t += 60_000;
  let r = await post(second, 'email', { kind: 'decline', action: 'sent' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.application.emails.decline, { sentBy: SECOND_ADMIN, sentAt: '2026-11-19T15:01:00.000Z' });
  assert.equal(r.body.application.status, 'declined', 'recording an email decides nothing');
  assert.equal((await post(first, 'email', { kind: 'decline', action: 'sent' })).status, 409, 'not twice');

  // The decision changes. The decline email still went out, so its record stays.
  app.clock.t += 60_000;
  r = await post(first, 'status', { status: 'approved' });
  assert.deepEqual(r.body.application.emails.decline, { sentBy: SECOND_ADMIN, sentAt: '2026-11-19T15:01:00.000Z' });
  assert.equal((await post(first, 'email', { kind: 'decline', action: 'sent' })).status, 409, 'no decline email for an approved application');

  r = await post(first, 'email', { kind: 'welcome', action: 'sent' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.application.emails.welcome, { sentBy: ADMIN, sentAt: '2026-11-19T15:02:00.000Z' });
  assert.equal(r.body.application.invitation.status, 'not_sent', 'a welcome email invites nobody to Slack');

  // Clearing one leaves the other.
  r = await post(second, 'email', { kind: 'decline', action: 'clear' });
  assert.deepEqual(r.body.application.emails, { welcome: { sentBy: ADMIN, sentAt: '2026-11-19T15:02:00.000Z' }, decline: { sentBy: null, sentAt: null } });
  assert.equal((await post(second, 'email', { kind: 'decline', action: 'clear' })).status, 200, 'clearing twice is harmless');

  assert.equal((await post(first, 'email', { kind: 'newsletter', action: 'sent' })).status, 400);
  assert.equal((await post(first, 'email', { kind: 'constructor', action: 'sent' })).status, 400);
  assert.equal((await post(first, 'email', { kind: 'welcome', action: 'banana' })).status, 400);
  assert.equal((await post(first, 'email', { action: 'sent' })).status, 400);

  const doc = await only(app);
  assert.deepEqual(doc.history.filter((e) => e.action === 'email').map((e) => [e.by, e.kind, e.to]), [
    [SECOND_ADMIN, 'decline', 'sent'],
    [ADMIN, 'welcome', 'sent'],
    [SECOND_ADMIN, 'decline', 'not_sent'],
  ]);
  assert.deepEqual(doc.answers, { ...valid(), linkedinUrl: 'https://linkedin.com/in/test-applicant' }, 'answers never change');
  assert.ok(app.logs.some((l) => l.includes('"application.email"')));
  await app.close();
});

test('only signed-in reviewers can record an email, and an applicant cannot claim one was sent', async () => {
  const app = await boot();
  await app.apply(valid({ emails: { welcome: { sentBy: 'me', sentAt: '2026-01-01T00:00:00.000Z' } } }));
  const id = (await only(app)).id;
  assert.deepEqual((await only(app)).emails, NONE);
  await app.call('POST', `/api/applications/${id}/status`, { cookie: app.cookieFor(ADMIN), body: { status: 'approved' } });
  const attempts = [
    {},
    { cookie: app.cookieFor(OUTSIDER) },
    { cookie: app.cookieFor(ADMIN), review: false },
    { cookie: app.cookieFor(ADMIN), headers: { Origin: 'https://evil.example' } },
  ];
  for (const attempt of attempts) {
    const res = await app.call('POST', `/api/applications/${id}/email`, { body: { kind: 'welcome', action: 'sent' }, ...attempt });
    assert.ok([401, 403].includes(res.status));
  }
  assert.deepEqual((await only(app)).emails, NONE);
  await app.close();
});

test('an application saved before these emails existed still works', async () => {
  const app = await boot();
  const old = made();
  delete old.emails;
  delete old.call;
  await app.store.create(old);
  const cookie = app.cookieFor(ADMIN);
  const list = await (await app.call('GET', '/api/applications', { cookie })).json();
  assert.deepEqual(list.applications[0].emails, NONE);
  await app.call('POST', `/api/applications/${old.id}/status`, { cookie, body: { status: 'declined' } });
  const res = await app.call('POST', `/api/applications/${old.id}/email`, { cookie, body: { kind: 'decline', action: 'sent' } });
  assert.equal(res.status, 200);
  assert.equal((await app.store.get(old.id)).emails.decline.sentBy, ADMIN);
  assert.deepEqual((await app.store.get(old.id)).emails.welcome, { sentBy: null, sentAt: null });
  await app.close();
});

test('the rules alone: each email needs its own decision', () => {
  const app = made();
  assert.throws(() => recordDecisionEmail(app, 'welcome', 'sent', ADMIN, '2026-11-19T15:01:00.000Z'), { code: 'wrong_status' });
  setStatus(app, 'approved', ADMIN, '2026-11-19T15:01:00.000Z');
  assert.throws(() => recordDecisionEmail(app, 'decline', 'sent', ADMIN, '2026-11-19T15:02:00.000Z'), { code: 'wrong_status' });
  recordDecisionEmail(app, 'welcome', 'sent', ADMIN, '2026-11-19T15:02:00.000Z');
  assert.throws(() => recordDecisionEmail(app, 'welcome', 'sent', ADMIN, '2026-11-19T15:03:00.000Z'), { code: 'already_recorded' });
  assert.throws(() => recordDecisionEmail(app, 'toString', 'sent', ADMIN, '2026-11-19T15:03:00.000Z'), { code: 'invalid_email' });
  assert.throws(() => recordDecisionEmail(app, 'welcome', 'resend', ADMIN, '2026-11-19T15:03:00.000Z'), { code: 'invalid_action' });
});

// ---------- the drafts ----------

test('the review page gets ready-to-send Gmail drafts for the welcome and the decline', async () => {
  const app = await boot();
  await app.apply(valid({ fullName: 'Jane Okafor-Smith', email: 'jane+bio@example.org' }));
  const cookie = app.cookieFor(SECOND_ADMIN);
  const list = await (await app.call('GET', '/api/applications', { cookie })).json();
  const { emailUrls, id } = list.applications[0];

  const welcome = new URL(emailUrls.welcome);
  assert.equal(welcome.origin + welcome.pathname, 'https://mail.google.com/mail/');
  assert.equal(welcome.searchParams.get('to'), 'jane+bio@example.org');
  assert.equal(welcome.searchParams.get('authuser'), SECOND_ADMIN);
  assert.equal(welcome.searchParams.get('su'), 'Welcome to Homology');
  assert.match(welcome.searchParams.get('body'), /^Hi Jane,\n\nYou're in\. Welcome to Homology\.\n\nYou'll get a Slack invitation at this address shortly\./);

  const decline = new URL(emailUrls.decline);
  assert.equal(decline.searchParams.get('to'), 'jane+bio@example.org');
  assert.equal(decline.searchParams.get('su'), 'Your Homology application');
  assert.match(decline.searchParams.get('body'), /^Hi Jane,\n\nThanks for applying to Homology and for telling us about your work\.\n\nWe aren't able to offer you a place right now\./);

  // The same links come back after a change, for whoever made it.
  const changed = await (await app.call('POST', `/api/applications/${id}/status`, { cookie: app.cookieFor(ADMIN), body: { status: 'approved' } })).json();
  assert.equal(new URL(changed.application.emailUrls.welcome).searchParams.get('authuser'), ADMIN);
  await app.close();
});

test('no draft carries a link into Slack, a shared invite or an em dash', () => {
  const app = made({ fullName: 'Jane Smith' });
  const letters = [callInviteEmail(app), callInviteEmail(app, { bookingUrl: 'https://cal.example.org/intro' }), welcomeEmail(app), declineEmail(app)];
  for (const { to, subject, body } of letters) {
    assert.equal(to, 'Test.Applicant@example.org');
    assert.ok(subject.length > 0 && subject.length < 60);
    assert.ok(!/slack\.com|join\.slack|shared_invite/i.test(body), 'never an invitation link');
    assert.ok(!body.includes('—') && !body.includes('–'), 'no em or en dashes');
    assert.ok(body.startsWith('Hi Jane,\n\n'));
    assert.ok(body.endsWith('\n\nAdarsh and Arthur'));
    assert.ok(!/\n{3,}/.test(body), 'single blank lines between paragraphs');
  }
  assert.ok(!welcomeEmail(app).body.includes('http'), 'the welcome email holds no link at all');
  assert.ok(!declineEmail(app).body.includes('http'));
  assert.match(callInviteEmail(app).body, /we'll confirm one\.\n\nMostly we want to hear what you're working on and who you'd want to meet/);
});

test('drafts fit where they are shown, and fall back to a bare draft when they cannot', () => {
  const longest = made({ fullName: `${'A'.repeat(40)} ${'b'.repeat(79)}`, email: `${'e'.repeat(240)}@example.org` });
  const full = draftUrls(longest, { bookingUrl: 'https://cal.com/homology/a-rather-long-booking-link-name', maxLength: 3000 });
  for (const kind of ['call', 'welcome', 'decline']) {
    const url = new URL(full[kind]);
    assert.ok(full[kind].length <= 3000, kind);
    assert.ok(url.searchParams.get('body').length > 100, `${kind} keeps its text`);
    assert.equal(url.searchParams.get('authuser'), null);
  }
  const tight = draftUrls(longest, { maxLength: 400, authuser: ADMIN });
  for (const kind of ['call', 'welcome', 'decline']) {
    const url = new URL(tight[kind]);
    assert.equal(url.searchParams.get('body'), null, 'too long: address and subject only');
    assert.equal(url.searchParams.get('to'), longest.answers.email);
    assert.equal(url.searchParams.get('authuser'), ADMIN);
  }
});
