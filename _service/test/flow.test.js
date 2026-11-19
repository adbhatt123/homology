import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THANKS } from '../src/server.js';
import { ADMIN, OUTSIDER, SECOND_ADMIN, SITE, boot, valid } from './helpers.js';

const only = async (app) => (await app.store.list())[0];

// ---------- applying ----------

test('applying saves a pending application and nothing more', async () => {
  const app = await boot();
  const res = await app.apply(valid());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, message: THANKS });
  assert.equal(THANKS, 'Thanks for applying. We review every application and will email you with next steps.');
  assert.equal(res.headers.get('set-cookie'), null, 'applying signs nobody in');

  const saved = await app.store.list();
  assert.equal(saved.length, 1);
  const doc = saved[0];
  assert.equal(doc.status, 'pending');
  assert.equal(doc.review, null);
  assert.equal(doc.invitation.status, 'not_sent');
  assert.equal(doc.notes.text, '');
  assert.equal(doc.createdAt, '2026-11-19T15:00:00.000Z');
  assert.deepEqual(doc.answers, { ...valid(), linkedinUrl: 'https://linkedin.com/in/test-applicant' });
  assert.equal(doc.emailKey, 'test.applicant@example.org');
  await app.close();
});

test('an applicant cannot set their own status or invitation', async () => {
  const app = await boot();
  await app.apply(valid({ status: 'approved', invitation: { status: 'joined' }, review: { by: 'me' }, id: 'x', notes: { text: 'hi' } }));
  const doc = await only(app);
  assert.equal(doc.status, 'pending');
  assert.equal(doc.invitation.status, 'not_sent');
  assert.equal(doc.review, null);
  assert.equal(doc.notes.text, '');
  assert.deepEqual(Object.keys(doc.answers).sort(), Object.keys(valid()).sort());
  await app.close();
});

test('a submission missing any required field is rejected and not stored', async () => {
  const app = await boot({ APPLY_PER_IP: '100' });
  for (const field of Object.keys(valid())) {
    const res = await app.apply(valid({ [field]: ' ' }));
    assert.equal(res.status, 422, field);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.deepEqual(Object.keys(body.errors), [field]);
  }
  assert.equal((await app.store.list()).length, 0);
  await app.close();
});

test('only the Homology site may post from a browser', async () => {
  const app = await boot();
  const ok = await app.apply(valid());
  assert.equal(ok.headers.get('access-control-allow-origin'), SITE);
  const other = await app.apply(valid(), { Origin: 'https://evil.example' });
  assert.equal(other.status, 403);
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  const preflight = await fetch(app.base + '/api/apply', { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), SITE);
  assert.equal((await app.store.list()).length, 1);
  await app.close();
});

test('the hidden trap field discards the submission quietly', async () => {
  const app = await boot();
  const res = await app.apply(valid({ company_website: 'http://spam.example' }));
  assert.equal(res.status, 200);
  assert.equal((await app.store.list()).length, 0);
  await app.close();
});

test('repeated submissions from one address are slowed down', async () => {
  const app = await boot({ APPLY_PER_IP: '3' });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await app.apply(valid({ email: `a${i}@example.org` }))).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  app.clock.t += 11 * 60_000;
  assert.equal((await app.apply(valid())).status, 200, 'allowed again after the window');
  assert.equal((await app.store.list()).length, 4);
  await app.close();
});

test('oversized and malformed bodies are refused', async () => {
  const app = await boot();
  assert.equal((await app.apply(valid({ workingOn: 'x'.repeat(40_000) }))).status, 413);
  const bad = await fetch(app.base + '/api/apply', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SITE }, body: '{nope' });
  assert.equal(bad.status, 400);
  const text = await fetch(app.base + '/api/apply', { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: SITE }, body: 'hi' });
  assert.equal(text.status, 415);
  assert.equal((await fetch(app.base + '/api/apply')).status, 405);
  assert.equal((await app.store.list()).length, 0);
  await app.close();
});

test('the form still works without JavaScript', async () => {
  const app = await boot();
  const post = (data) => fetch(app.base + '/api/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: SITE },
    body: new URLSearchParams(data).toString(),
  });
  const res = await post(valid());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.ok((await res.text()).includes(THANKS));
  const bad = await post(valid({ email: '', fullName: '<script>alert(1)</script>' }));
  assert.equal(bad.status, 422);
  const page = await bad.text();
  assert.ok(page.includes('Please enter your email address.'));
  assert.ok(!page.includes('<script>alert'));
  assert.equal((await app.store.list()).length, 1);
  await app.close();
});

// ---------- privacy and access ----------

test('applications cannot be read without signing in', async () => {
  const app = await boot();
  await app.apply(valid());
  const paths = ['/api/applications', '/api/session'];
  for (const path of paths) {
    const res = await app.call('GET', path);
    assert.equal(res.status, 401, path);
    assert.ok(!(await res.text()).includes('example.org'), 'no applicant data leaks');
  }
  const id = (await only(app)).id;
  for (const [path, body] of [[`/api/applications/${id}/status`, { status: 'approved' }], [`/api/applications/${id}/notes`, { text: 'x' }], [`/api/applications/${id}/invitation`, { action: 'sent' }]]) {
    assert.equal((await app.call('POST', path, { body })).status, 401, path);
  }
  assert.equal((await only(app)).status, 'pending');
  await app.close();
});

test('forged or expired sessions are refused', async () => {
  const app = await boot();
  const good = app.cookieFor(ADMIN);
  assert.equal((await app.call('GET', '/api/applications', { cookie: good })).status, 200);
  assert.equal((await app.call('GET', '/api/applications', { cookie: good.slice(0, -3) + 'abc' })).status, 401);
  assert.equal((await app.call('GET', '/api/applications', { cookie: 'homology_review=' + Buffer.from(JSON.stringify({ e: ADMIN, x: 9e15 })).toString('base64url') + '.AAAA' })).status, 401);
  app.clock.t += 2 * 3600_000;
  assert.equal((await app.call('GET', '/api/applications', { cookie: good })).status, 401, 'expired');
  await app.close();
});

test('a signed-in Google account that is not on the list gets nothing', async () => {
  const app = await boot({}, { identities: { 'tok-admin': { email: ADMIN }, 'tok-outsider': { email: OUTSIDER } } });
  await app.apply(valid());

  const refused = await app.call('POST', '/api/session', { body: { credential: 'tok-outsider' } });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('set-cookie'), null);

  const fake = await app.call('POST', '/api/session', { body: { credential: 'made-up-token' } });
  assert.equal(fake.status, 401);
  assert.equal(fake.headers.get('set-cookie'), null);

  // Even a correctly signed session for a non-admin address is refused.
  assert.equal((await app.call('GET', '/api/applications', { cookie: app.cookieFor(OUTSIDER) })).status, 403);

  const ok = await app.call('POST', '/api/session', { body: { credential: 'tok-admin' } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const list = await app.call('GET', '/api/applications', { cookie: cookie.split(';')[0] });
  assert.equal((await list.json()).applications.length, 1);
  await app.close();
});

test('removing a reviewer from the list takes effect immediately', async () => {
  const app = await boot();
  const cookie = app.cookieFor(SECOND_ADMIN);
  assert.equal((await app.call('GET', '/api/applications', { cookie })).status, 200);
  app.cfg.adminEmails.splice(app.cfg.adminEmails.indexOf(SECOND_ADMIN), 1);
  assert.equal((await app.call('GET', '/api/applications', { cookie })).status, 403);
  await app.close();
});

test('changes must come from the review page itself', async () => {
  const app = await boot();
  await app.apply(valid());
  const id = (await only(app)).id;
  const cookie = app.cookieFor(ADMIN);
  const body = { status: 'approved' };
  assert.equal((await app.call('POST', `/api/applications/${id}/status`, { cookie, body, review: false })).status, 403, 'missing header');
  assert.equal((await app.call('POST', `/api/applications/${id}/status`, { cookie, body, headers: { Origin: 'https://evil.example' } })).status, 403, 'other site');
  assert.equal((await only(app)).status, 'pending');
  const list = await app.call('GET', '/api/applications', { cookie, headers: { Origin: 'https://evil.example' } });
  assert.equal(list.headers.get('access-control-allow-origin'), null, 'other sites cannot read responses');
  await app.close();
});

test('local sign-in does not exist unless switched on, and never in production', async () => {
  const off = await boot();
  assert.equal((await off.call('POST', '/api/dev-session', { body: { email: ADMIN } })).status, 404);
  assert.equal((await (await off.call('GET', '/api/config')).json()).devLogin, false);
  await off.close();
  const on = await boot({ ALLOW_DEV_LOGIN: '1' });
  assert.equal((await on.call('POST', '/api/dev-session', { body: { email: OUTSIDER } })).status, 403);
  assert.equal((await on.call('POST', '/api/dev-session', { body: { email: ADMIN } })).status, 200);
  await on.close();
});

test('the review page shell holds no applicant data', async () => {
  const app = await boot();
  await app.apply(valid());
  for (const path of ['/review', '/review.js', '/review.css', '/api/config']) {
    const res = await fetch(app.base + path);
    assert.equal(res.status, 200, path);
    const text = await res.text();
    assert.ok(!text.includes('Test Applicant') && !text.includes('example.org'), path);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  const page = await fetch(app.base + '/review');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  await app.close();
});

// ---------- applying, approval and invitation stay separate ----------

test('review, notes and invitation are separate, ordered and attributed', async () => {
  const app = await boot();
  await app.apply(valid());
  const id = (await only(app)).id;
  const first = app.cookieFor(ADMIN);
  const second = app.cookieFor(SECOND_ADMIN);
  const post = async (cookie, path, body) => {
    const res = await app.call('POST', `/api/applications/${id}/${path}`, { cookie, body });
    return { status: res.status, body: await res.json() };
  };

  // Not approved yet: no invitation can be recorded.
  let r = await post(first, 'invitation', { action: 'sent' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'not_approved');
  assert.equal((await only(app)).invitation.status, 'not_sent');

  // Declined: still no invitation.
  app.clock.t += 60_000;
  r = await post(first, 'status', { status: 'declined' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.application.review, { by: ADMIN, at: '2026-11-19T15:01:00.000Z' });
  assert.equal((await post(first, 'invitation', { action: 'sent' })).status, 409);
  assert.equal((await post(first, 'invitation', { action: 'joined' })).status, 409);

  // A second reviewer approves. Approval alone invites nobody.
  app.clock.t += 60_000;
  r = await post(second, 'status', { status: 'approved' });
  assert.equal(r.body.application.status, 'approved');
  assert.deepEqual(r.body.application.review, { by: SECOND_ADMIN, at: '2026-11-19T15:02:00.000Z' });
  assert.equal(r.body.application.invitation.status, 'not_sent');
  assert.equal((await post(second, 'invitation', { action: 'joined' })).status, 409, 'cannot skip the invitation');

  // Notes are saved with who and when.
  r = await post(first, 'notes', { text: '  Strong fit. Introduce to the trials group.  ' });
  assert.deepEqual(r.body.application.notes, { text: 'Strong fit. Introduce to the trials group.', updatedBy: ADMIN, updatedAt: '2026-11-19T15:02:00.000Z' });
  assert.equal((await post(first, 'notes', { text: 'x'.repeat(5001) })).status, 400);

  // The explicit invitation step, recorded separately from the approval.
  app.clock.t += 60_000;
  r = await post(first, 'invitation', { action: 'sent' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.application.invitation, {
    status: 'sent', method: 'manual', sentBy: ADMIN, sentAt: '2026-11-19T15:03:00.000Z', joinedRecordedBy: null, joinedAt: null,
  });
  assert.deepEqual(r.body.application.review, { by: SECOND_ADMIN, at: '2026-11-19T15:02:00.000Z' }, 'approval record untouched');
  assert.equal((await post(first, 'invitation', { action: 'sent' })).status, 409, 'not twice');

  // While an invitation is on record the decision cannot be quietly reversed.
  r = await post(first, 'status', { status: 'declined' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'invitation_on_record');

  r = await post(second, 'invitation', { action: 'joined' });
  assert.equal(r.body.application.invitation.status, 'joined');
  assert.equal(r.body.application.invitation.joinedRecordedBy, SECOND_ADMIN);

  r = await post(first, 'invitation', { action: 'clear' });
  assert.equal(r.body.application.invitation.status, 'not_sent');
  assert.equal((await post(first, 'status', { status: 'declined' })).status, 200);

  const doc = await only(app);
  assert.deepEqual(doc.answers, { ...valid(), linkedinUrl: 'https://linkedin.com/in/test-applicant' }, 'answers never change');
  assert.deepEqual(doc.history.map((e) => [e.by, e.action, e.to || '']), [
    ['applicant', 'submitted', ''],
    [ADMIN, 'status', 'declined'],
    [SECOND_ADMIN, 'status', 'approved'],
    [ADMIN, 'notes', ''],
    [ADMIN, 'invitation', 'sent'],
    [SECOND_ADMIN, 'invitation', 'joined'],
    [ADMIN, 'invitation', 'not_sent'],
    [ADMIN, 'status', 'declined'],
  ]);

  assert.equal((await post(first, 'status', { status: 'banana' })).status, 400);
  assert.equal((await post(first, 'invitation', { action: 'banana' })).status, 409, 'declined: nothing but clear is possible');
  assert.equal((await app.call('POST', '/api/applications/00000000-0000-4000-8000-000000000000/status', { cookie: first, body: { status: 'approved' } })).status, 404);
  await app.close();
});

test('no step of the flow contacts Slack or any other outside service', async () => {
  const app = await boot();
  const real = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = (url, ...rest) => {
    if (!String(url).startsWith(app.base)) outbound.push(String(url));
    return real(url, ...rest);
  };
  try {
    await app.apply(valid());
    const id = (await only(app)).id;
    const cookie = app.cookieFor(ADMIN);
    for (const [path, body] of [['status', { status: 'approved' }], ['invitation', { action: 'sent' }], ['invitation', { action: 'joined' }]]) {
      assert.equal((await app.call('POST', `/api/applications/${id}/${path}`, { cookie, body })).status, 200);
    }
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(outbound, []);
  await app.close();
});

test('the service never publishes an invitation link', async () => {
  const app = await boot();
  const config = await (await fetch(app.base + '/api/config')).json();
  assert.deepEqual(config.slack, {
    workspaceUrl: 'https://homologybio.slack.com',
    invitePeopleUrl: 'https://homologybio.slack.com/admin/invites',
    integration: 'manual',
  });
  for (const path of ['/review', '/review.js', '/api/config']) {
    const text = await (await fetch(app.base + path)).text();
    assert.ok(!/shared_invite|join\.slack\.com/.test(text), path);
  }
  await app.close();
});

test('logs record events without applicant answers', async () => {
  const app = await boot();
  await app.apply(valid());
  const joined = app.logs.join('\n');
  assert.match(joined, /application\.submitted/);
  assert.ok(!joined.includes('example.org') && !joined.includes('Test Applicant') && !joined.includes('oncology'));
  await app.close();
});

test('a repeat application from the same email is kept and flagged for reviewers', async () => {
  const app = await boot();
  await app.apply(valid());
  app.clock.t += 1000;
  await app.apply(valid({ email: 'TEST.applicant@example.org', workingOn: 'A newer answer.' }));
  const list = await (await app.call('GET', '/api/applications', { cookie: app.cookieFor(ADMIN) })).json();
  assert.equal(list.applications.length, 2);
  assert.deepEqual(list.applications.map((a) => a.otherApplications), [1, 1]);
  assert.equal(list.applications[0].answers.workingOn, 'A newer answer.', 'newest first');
  await app.close();
});
