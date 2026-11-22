import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newIntroduction, setIntroReason, setIntroStatus } from '../src/introductions.js';
import { ADMIN, OUTSIDER, SECOND_ADMIN, boot, valid } from './helpers.js';

const ID_A = '0b0f6c1e-3b1a-4c53-9d4e-2f6a1c7d8e90';
const ID_B = '1c1f6c1e-3b1a-4c53-9d4e-2f6a1c7d8e91';

// Three applicants: Ana and Ben are approved members, Cal is still pending.
async function community(envOver = {}, extra = {}) {
  const app = await boot({ APPLY_PER_IP: '100', ...envOver }, extra);
  await app.apply(valid({ fullName: 'Ana Member', email: 'ana@example.org', introWish: 'Someone running early oncology trials.' }));
  await app.apply(valid({ fullName: 'Ben Member', email: 'ben@example.org', canHelpWith: 'Running early oncology trials.' }));
  await app.apply(valid({ fullName: 'Cal Pending', email: 'cal@example.org' }));
  const all = await app.store.list();
  const by = (email) => all.find((a) => a.emailKey === email);
  const [ana, ben, cal] = [by('ana@example.org'), by('ben@example.org'), by('cal@example.org')];
  const cookie = app.cookieFor(ADMIN);
  for (const m of [ana, ben]) await app.call('POST', `/api/applications/${m.id}/status`, { cookie, body: { status: 'approved' } });
  const post = async (path, body, who = cookie) => {
    const res = await app.call('POST', `/api/introductions${path}`, { cookie: who, body });
    return { status: res.status, body: await res.json() };
  };
  const list = async (who = cookie) => (await (await app.call('GET', '/api/introductions', { cookie: who })).json()).introductions;
  return { app, ana, ben, cal, cookie, post, list };
}

// ---------- who can see and record them ----------

test('introductions are private to signed-in reviewers', async () => {
  const { app, ana, ben, post } = await community();
  const made = await post('', { forId: ana.id, withId: ben.id, reason: 'Ben runs the trials Ana asked about.' });
  assert.equal(made.status, 200);
  const id = made.body.introduction.id;

  assert.equal((await app.call('GET', '/api/introductions')).status, 401);
  assert.equal((await app.call('GET', '/api/introductions', { cookie: app.cookieFor(OUTSIDER) })).status, 403);
  const body = { forId: ana.id, withId: ben.id };
  const attempts = [
    {},
    { cookie: app.cookieFor(OUTSIDER) },
    { cookie: app.cookieFor(ADMIN), review: false },
    { cookie: app.cookieFor(ADMIN), headers: { Origin: 'https://evil.example' } },
  ];
  for (const attempt of attempts) {
    for (const [path, payload] of [['', body], [`/${id}/status`, { status: 'made' }], [`/${id}/reason`, { text: 'x' }]]) {
      const res = await app.call('POST', `/api/introductions${path}`, { body: payload, ...attempt });
      assert.ok([401, 403].includes(res.status), `${path || '/'} -> ${res.status}`);
    }
  }
  const saved = await app.intros.list();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'suggested');
  assert.equal(saved[0].reason, 'Ben runs the trials Ana asked about.');

  // Nothing about introductions is shown before sign-in.
  const config = await (await fetch(app.base + '/api/config')).text();
  assert.ok(!config.includes('ntroduction'));
  await app.close();
});

// ---------- recording one ----------

test('an introduction is recorded with who it is for, who with, why, and who made it', async () => {
  const { app, ana, ben, post, list } = await community();
  app.clock.t += 60_000;
  const r = await post('', { forId: ana.id, withId: ben.id, reason: '  Ben runs the trials Ana asked about.  ' }, app.cookieFor(SECOND_ADMIN));
  assert.equal(r.status, 200);
  const intro = r.body.introduction;
  assert.match(intro.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(intro, {
    id: intro.id,
    schema: 1,
    createdAt: '2026-11-19T15:01:00.000Z',
    createdBy: SECOND_ADMIN,
    forId: ana.id,
    withId: ben.id,
    outside: null,
    reason: 'Ben runs the trials Ana asked about.',
    status: 'suggested',
    updatedAt: '2026-11-19T15:01:00.000Z',
    updatedBy: SECOND_ADMIN,
    history: [{ at: '2026-11-19T15:01:00.000Z', by: SECOND_ADMIN, action: 'created', to: 'suggested' }],
  });
  assert.deepEqual(await list(), [intro]);

  const res = await app.call('GET', '/api/introductions', { cookie: app.cookieFor(ADMIN) });
  assert.deepEqual((await res.json()).statusLabels, { suggested: 'Suggested', asked: 'Both asked', made: 'Made', happened: 'Happened', dropped: 'Dropped' });

  // Recording one changes nothing about either application, and contacts nobody.
  for (const m of [ana, ben]) {
    const now = await app.store.get(m.id);
    assert.deepEqual(now.answers, m.answers);
    assert.equal(now.status, 'approved');
    assert.equal(now.invitation.status, 'not_sent');
    assert.equal(now.history.length, 2);
  }
  await app.close();
});

test('an introduction can be with someone outside Homology, by name only', async () => {
  const { app, ana, post } = await community();
  const r = await post('', { forId: ana.id, outside: { name: '  Dana Outside ', about: 'Runs a trials unit', email: 'dana@example.org' }, status: 'made' });
  assert.equal(r.status, 200);
  assert.equal(r.body.introduction.withId, null);
  assert.deepEqual(r.body.introduction.outside, { name: 'Dana Outside', about: 'Runs a trials unit' }, 'no contact details are kept for outsiders');
  assert.equal(r.body.introduction.status, 'made', 'one that already happened can be recorded as it stands');
  assert.deepEqual(r.body.introduction.history.map((e) => [e.action, e.to]), [['created', 'made']]);
  await app.close();
});

test('only approved members can be introduced, and never to themselves', async () => {
  const { app, ana, ben, cal, post } = await community();
  const cases = [
    [{ forId: cal.id, withId: ben.id }, 409, 'not_a_member'],
    [{ forId: ana.id, withId: cal.id }, 409, 'not_a_member'],
    [{ forId: ana.id, withId: ana.id }, 400, 'same_person'],
    [{ forId: ana.id }, 400, 'invalid_other'],
    [{ forId: ana.id, withId: ben.id, outside: { name: 'Dana' } }, 400, 'invalid_other'],
    [{ withId: ben.id }, 400, 'invalid_member'],
    [{ forId: 'not-an-id', withId: ben.id }, 400, 'invalid_member'],
    [{ forId: ana.id, withId: '../../etc/passwd' }, 400, 'invalid_member'],
    [{ forId: ID_A, withId: ben.id }, 404, 'unknown_member'],
    [{ forId: ana.id, withId: ID_B }, 404, 'unknown_member'],
    [{ forId: ana.id, withId: ben.id, status: 'married' }, 400, 'invalid_status'],
    [{ forId: ana.id, withId: ben.id, reason: 'x'.repeat(1001) }, 400, 'reason_too_long'],
    [{ forId: ana.id, withId: ben.id, reason: { a: 1 } }, 400, 'invalid_reason'],
    [{ forId: ana.id, outside: { name: 'n'.repeat(121) } }, 400, 'name_too_long'],
    [{ forId: ana.id, outside: { name: 'Dana', about: 'a'.repeat(201) } }, 400, 'about_too_long'],
  ];
  for (const [body, status, error] of cases) {
    const r = await post('', body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal(r.body.error, error, JSON.stringify(body));
  }
  assert.equal((await app.intros.list()).length, 0, 'nothing was saved');

  // Someone who was a member and is no longer: old introductions stay, new ones are refused.
  const kept = await post('', { forId: ana.id, withId: ben.id });
  assert.equal(kept.status, 200);
  await app.call('POST', `/api/applications/${ben.id}/status`, { cookie: app.cookieFor(ADMIN), body: { status: 'declined' } });
  assert.equal((await post('', { forId: ana.id, withId: ben.id })).status, 409);
  assert.equal((await app.intros.list()).length, 1);
  await app.close();
});

// ---------- following one through ----------

test('an introduction moves through its steps, each recorded with who and when', async () => {
  const { app, ana, ben, post, list } = await community();
  const { id } = (await post('', { forId: ana.id, withId: ben.id })).body.introduction;
  const second = app.cookieFor(SECOND_ADMIN);

  for (const [status, who, minute] of [['asked', second, 1], ['made', undefined, 2], ['happened', second, 3]]) {
    app.clock.t += 60_000;
    const r = await post(`/${id}/status`, { status }, who);
    assert.equal(r.status, 200);
    assert.equal(r.body.introduction.status, status);
    assert.equal(r.body.introduction.updatedAt, `2026-11-19T15:0${minute}:00.000Z`);
  }
  assert.equal((await post(`/${id}/status`, { status: 'happened' })).status, 200, 'the same step twice is harmless');
  assert.equal((await post(`/${id}/status`, { status: 'banana' })).body.error, 'invalid_status');
  assert.equal((await post(`/${ID_A}/status`, { status: 'made' })).status, 404);
  assert.equal((await post('/not-an-id/status', { status: 'made' })).status, 404);

  // The reason can be corrected, and that is recorded too.
  app.clock.t += 60_000;
  let r = await post(`/${id}/reason`, { text: 'They met at the dinner and hit it off.' });
  assert.equal(r.body.introduction.reason, 'They met at the dinner and hit it off.');
  assert.equal((await post(`/${id}/reason`, { text: 'x'.repeat(1001) })).status, 400);
  assert.equal((await post(`/${id}/reason`, { text: 42 })).status, 400);

  // One that will not go ahead is dropped, and can be picked up again.
  r = await post(`/${id}/status`, { status: 'dropped' });
  assert.equal(r.body.introduction.status, 'dropped');
  await post(`/${id}/status`, { status: 'suggested' });

  const [saved] = await list();
  assert.equal(saved.createdBy, ADMIN, 'who first recorded it does not change');
  assert.deepEqual(saved.history.map((e) => [e.by, e.action, e.from || '', e.to || '']), [
    [ADMIN, 'created', '', 'suggested'],
    [SECOND_ADMIN, 'status', 'suggested', 'asked'],
    [ADMIN, 'status', 'asked', 'made'],
    [SECOND_ADMIN, 'status', 'made', 'happened'],
    [ADMIN, 'reason', '', ''],
    [ADMIN, 'status', 'happened', 'dropped'],
    [ADMIN, 'status', 'dropped', 'suggested'],
  ]);
  assert.deepEqual([saved.forId, saved.withId], [ana.id, ben.id], 'who it is between never changes');
  await app.close();
});

test('the list is newest first and holds only what reviewers recorded', async () => {
  const { app, ana, ben, post, list } = await community();
  await post('', { forId: ana.id, withId: ben.id, reason: 'first' });
  app.clock.t += 60_000;
  await post('', { forId: ben.id, outside: { name: 'Dana Outside' }, reason: 'second' });
  const all = await list();
  assert.deepEqual(all.map((i) => i.reason), ['second', 'first']);
  for (const intro of all) {
    assert.deepEqual(Object.keys(intro).sort(), ['createdAt', 'createdBy', 'forId', 'history', 'id', 'outside', 'reason', 'schema', 'status', 'updatedAt', 'updatedBy', 'withId']);
    assert.ok(!JSON.stringify(intro).includes('example.org') || JSON.stringify(intro).includes('reviewer@example.org'), 'no applicant address is copied into it');
  }
  await app.close();
});

test('recording an introduction sends nothing to Slack or by email', async () => {
  let slackCalls = 0;
  let mailCalls = 0;
  const slackFetch = async () => {
    slackCalls += 1;
    return new Response(JSON.stringify({ ok: true, user_id: 'U0BOT000001', ts: `1795000000.00000${slackCalls}`, channel: { is_private: true }, members: ['U0BOT000001', 'U0REVIEW001'] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const mailFetch = async () => {
    mailCalls += 1;
    return new Response(JSON.stringify({ id: 'made-up-id' }), { status: 200 });
  };
  const { app, ana, ben, post } = await community(
    {
      SLACK_BOT_TOKEN: 'xoxb-made-up-for-tests',
      SLACK_SIGNING_SECRET: 'signing-secret-used-only-in-tests',
      SLACK_REVIEW_CHANNEL: 'C0REVIEW001',
      SLACK_REVIEWERS: `U0REVIEW001=${ADMIN}`,
      SLACK_TEAM_ID: 'T0TEAM00001',
      SERVICE_URL: 'https://review.example.org',
      RESEND_API_KEY: 're_made_up_key_for_tests',
      EMAIL_FROM: 'Homology <hello@homology.bio>',
    },
    { slackFetch, mailFetch },
  );
  const before = [slackCalls, mailCalls];
  assert.ok(before[0] > 0 && before[1] > 0, 'applying and approving did reach both');
  const { id } = (await post('', { forId: ana.id, withId: ben.id, reason: 'They should meet.' })).body.introduction;
  for (const status of ['asked', 'made', 'happened']) await post(`/${id}/status`, { status });
  await post(`/${id}/reason`, { text: 'They met.' });
  assert.deepEqual([slackCalls, mailCalls], before, 'introductions reach nobody on their own');
  await app.close();
});

test('logs record introductions by id, without names or reasons', async () => {
  const { app, ana, ben, post } = await community();
  const { id } = (await post('', { forId: ana.id, withId: ben.id, reason: 'A private reason.' })).body.introduction;
  await post('', { forId: ana.id, outside: { name: 'Dana Outside', about: 'Private detail' } });
  await post(`/${id}/status`, { status: 'made' });
  const all = app.logs.join('\n');
  for (const value of ['A private reason.', 'Dana Outside', 'Private detail', 'Ana Member', 'Ben Member']) {
    assert.ok(!all.includes(value), `log must not contain "${value}"`);
  }
  assert.ok(all.includes('"introduction.created"'));
  assert.ok(all.includes('"introduction.status"'));
  assert.ok(all.includes(id));
  await app.close();
});

// ---------- the rules on their own ----------

test('the rules alone', () => {
  const t = '2026-11-19T15:00:00.000Z';
  const intro = newIntroduction({ forId: ID_A, withId: ID_B }, ADMIN, t, ID_A);
  assert.equal(intro.status, 'suggested');
  assert.equal(intro.reason, '');
  assert.throws(() => newIntroduction(null, ADMIN, t, ID_A), { code: 'invalid_member' });
  assert.throws(() => newIntroduction({ forId: ID_A, withId: ID_A }, ADMIN, t, ID_A), { code: 'same_person' });
  assert.throws(() => newIntroduction({ forId: ID_A, outside: 'Dana' }, ADMIN, t, ID_A), { code: 'invalid_other' });
  assert.throws(() => setIntroStatus(intro, 'done', ADMIN, t), { code: 'invalid_status' });
  assert.equal(setIntroStatus(intro, 'suggested', ADMIN, t).history.length, 1, 'no change, no entry');
  assert.equal(setIntroReason(intro, '', ADMIN, t).history.length, 1);
  setIntroReason(intro, 'Line one.\r\nLine two.', SECOND_ADMIN, '2026-11-19T16:00:00.000Z');
  assert.equal(intro.reason, 'Line one.\nLine two.');
  assert.equal(intro.updatedBy, SECOND_ADMIN);
});
