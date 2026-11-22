import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { THANKS } from '../src/server.js';
import { applicationMessage, verifySlackSignature } from '../src/slack.js';
import { newApplication } from '../src/applications.js';
import { ADMIN, SECOND_ADMIN, boot, valid } from './helpers.js';

const TEAM = 'T0TEAM00001';
const CHANNEL = 'C0REVIEW001';
const REVIEWER = 'U0REVIEW001';
const SECOND_REVIEWER = 'U0REVIEW002';
const MEMBER = 'U0MEMBER999';
const BOT = 'U0BOT000001';
const SECRET = 'signing-secret-used-only-in-tests';

const SLACK = {
  SLACK_BOT_TOKEN: 'xoxb-made-up-for-tests',
  SLACK_SIGNING_SECRET: SECRET,
  SLACK_REVIEW_CHANNEL: CHANNEL,
  SLACK_REVIEWERS: `${REVIEWER}=${ADMIN}, ${SECOND_REVIEWER}=${SECOND_ADMIN}`,
  SLACK_TEAM_ID: TEAM,
  SERVICE_URL: 'https://review.example.org',
};

// Stands in for Slack. Records every call so a test can see exactly what was sent.
function fakeSlack({ isPrivate = true, shared = false, members = [REVIEWER, SECOND_REVIEWER, BOT], fail = {} } = {}) {
  const state = { isPrivate, shared, members, fail, calls: [], whispers: [], posted: 0 };
  const json = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = async (url, init) => {
    const address = String(url);
    if (address.startsWith('https://hooks.slack.com/')) {
      state.whispers.push(JSON.parse(init.body));
      return new Response('ok');
    }
    assert.ok(address.startsWith('https://slack.com/api/'), `unexpected address ${address}`);
    const method = address.slice('https://slack.com/api/'.length);
    const args = Object.fromEntries(new URLSearchParams(init.body));
    for (const key of ['blocks', 'view']) if (args[key]) args[key] = JSON.parse(args[key]);
    state.calls.push({ method, args, auth: init.headers.Authorization });
    if (state.fail[method] === 'network') throw new Error('network down');
    if (state.fail[method]) return json({ ok: false, error: state.fail[method] });
    if (method === 'auth.test') return json({ ok: true, user_id: BOT });
    if (method === 'conversations.info') return json({ ok: true, channel: { id: CHANNEL, is_private: state.isPrivate, is_ext_shared: state.shared } });
    if (method === 'conversations.members') return json({ ok: true, members: state.members, response_metadata: { next_cursor: '' } });
    if (method === 'chat.postMessage') return json({ ok: true, channel: CHANNEL, ts: `1795000000.00000${++state.posted}` });
    if (method === 'chat.update') return json({ ok: true, ts: args.ts });
    if (method === 'views.open') return json({ ok: true });
    return json({ ok: false, error: 'unknown_method' });
  };
  return { state, fetchImpl, of: (method) => state.calls.filter((c) => c.method === method) };
}

async function start(slackOptions = {}, envOver = {}) {
  const slack = fakeSlack(slackOptions);
  const app = await boot({ ...SLACK, ...envOver }, { slackFetch: slack.fetchImpl });
  return { app, slack };
}

const only = async (app) => (await app.store.list())[0];

// Sends what Slack sends when someone presses a button, signed the way Slack signs it.
function send(app, payload, { secret = SECRET, at = app.clock.t, signed = true, signature } = {}) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = String(Math.floor(at / 1000));
  const sig = signature || `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  return fetch(app.base + '/api/slack/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(signed ? { 'X-Slack-Request-Timestamp': timestamp, 'X-Slack-Signature': sig } : {}),
    },
    body,
  });
}

const press = (actionId, id, over = {}) => ({
  type: 'block_actions',
  team: { id: TEAM },
  user: { id: REVIEWER },
  container: { type: 'message', channel_id: CHANNEL, message_ts: '1795000000.000001' },
  response_url: 'https://hooks.slack.com/actions/T0TEAM00001/1/made-up',
  trigger_id: 'trigger.made-up',
  actions: [{ action_id: actionId, value: id }],
  ...over,
});

const texts = (blocks, type) => {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return undefined;
    if (node.type === type && typeof node.text === 'string') found.push(node.text);
    return Object.values(node).forEach(walk);
  };
  walk(blocks);
  return found;
};
// Everything Slack will show exactly as typed: plain text objects and the text inside rich text blocks.
const shown = (blocks) => [...texts(blocks, 'plain_text'), ...texts(blocks, 'text')];
const buttons = (blocks) => blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.action_id));

// ---------- settings ----------

test('Slack review is off unless every Slack setting is present', () => {
  const base = { ADMIN_EMAILS: `${ADMIN},${SECOND_ADMIN}` };
  assert.equal(loadConfig(base).cfg.slack.enabled, false);
  assert.deepEqual(loadConfig(base).problems, []);

  const partial = loadConfig({ ...base, SLACK_BOT_TOKEN: 'x', SLACK_REVIEW_CHANNEL: CHANNEL });
  assert.equal(partial.cfg.slack.enabled, false);
  assert.match(partial.problems.join(' '), /Missing: SLACK_SIGNING_SECRET, SLACK_REVIEWERS, SERVICE_URL/);

  const full = loadConfig({ ...base, ...SLACK });
  assert.deepEqual(full.problems, []);
  assert.equal(full.cfg.slack.enabled, true);
  assert.deepEqual(full.cfg.slack.reviewers, { [REVIEWER]: ADMIN, [SECOND_REVIEWER]: SECOND_ADMIN });
});

test('a Slack reviewer must already be an authorized reviewer', () => {
  const base = { ADMIN_EMAILS: ADMIN, ...SLACK };
  assert.match(loadConfig(base).problems.join(' '), /must also be in ADMIN_EMAILS.*second\.reviewer@example\.org/);
  assert.match(loadConfig({ ...base, SLACK_REVIEWERS: `bob=${ADMIN}` }).problems.join(' '), /SLACK_REVIEWERS must look like/);
  assert.match(loadConfig({ ...base, SLACK_REVIEWERS: `${REVIEWER}=${ADMIN}`, SLACK_REVIEW_CHANNEL: '#applications' }).problems.join(' '), /must be a channel ID/);
  assert.match(loadConfig({ ...base, SLACK_REVIEWERS: `${REVIEWER}=${ADMIN}`, SERVICE_URL: 'http://review.example.org' }).problems.join(' '), /SERVICE_URL/);
});

test('with Slack review off, nothing is sent to Slack and the endpoint does not exist', async () => {
  const slack = fakeSlack();
  const app = await boot({}, { slackFetch: slack.fetchImpl });
  assert.equal((await app.apply(valid())).status, 200);
  const doc = await only(app);
  await app.call('POST', `/api/applications/${doc.id}/status`, { body: { status: 'approved' }, cookie: app.cookieFor(ADMIN) });
  assert.equal(slack.state.calls.length, 0);
  assert.equal((await send(app, press('status_declined', doc.id))).status, 404);
  assert.equal((await only(app)).status, 'approved');
  await app.close();
});

// ---------- the signature ----------

test('a request is trusted only with a fresh, correct Slack signature', () => {
  const nowMs = Date.parse('2026-11-19T15:00:00.000Z');
  const timestamp = String(nowMs / 1000);
  const rawBody = Buffer.from('payload=%7B%7D');
  const signature = `v0=${createHmac('sha256', SECRET).update(`v0:${timestamp}:`).update(rawBody).digest('hex')}`;
  const check = (over) => verifySlackSignature({ signingSecret: SECRET, timestamp, signature, rawBody, nowMs, ...over });
  assert.equal(check({}), true);
  assert.equal(check({ signingSecret: 'another-secret' }), false);
  assert.equal(check({ rawBody: Buffer.from('payload=%7B%22a%22%3A1%7D') }), false);
  assert.equal(check({ signature: signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0') }), false);
  assert.equal(check({ signature: '' }), false);
  assert.equal(check({ signature: undefined }), false);
  assert.equal(check({ timestamp: 'abc' }), false);
  assert.equal(check({ signingSecret: '' }), false);
  assert.equal(check({ nowMs: nowMs + 301_000 }), false, 'older than five minutes');
  assert.equal(check({ nowMs: nowMs - 301_000 }), false, 'from the future');
  assert.equal(check({ nowMs: nowMs + 299_000 }), true);
});

// ---------- a new application ----------

test('a new application is posted once to the reviewers channel, and still only pending', async () => {
  const { app, slack } = await start();
  const res = await app.apply(valid());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, message: THANKS }, 'the applicant is told nothing new');

  const posts = slack.of('chat.postMessage');
  assert.equal(posts.length, 1);
  const { args, auth } = posts[0];
  assert.equal(auth, `Bearer ${SLACK.SLACK_BOT_TOKEN}`);
  assert.equal(args.channel, CHANNEL);
  assert.equal(args.text, 'New Homology application', 'the notification line names nobody');
  assert.equal(args.unfurl_links, 'false');

  const seen = shown(args.blocks);
  const a = { ...valid(), linkedinUrl: 'https://linkedin.com/in/test-applicant' };
  for (const field of Object.keys(a)) assert.ok(seen.includes(a[field]), `${field} is shown exactly as written`);
  assert.deepEqual(buttons(args.blocks), ['status_call', 'status_approved', 'status_declined', 'notes_edit', 'link_profile', 'link_review']);
  assert.match(texts(args.blocks, 'mrkdwn').join('\n'), /\*Pending review\*/);

  const doc = await only(app);
  assert.equal(doc.status, 'pending');
  assert.equal(doc.review, null);
  assert.equal(doc.invitation.status, 'not_sent');
  assert.deepEqual(doc.slack, { channel: CHANNEL, ts: '1795000000.000001', full: true });
  assert.equal(slack.of('chat.update').length, 0);
  assert.equal(slack.of('views.open').length, 0);
  const methods = new Set(slack.state.calls.map((c) => c.method));
  assert.deepEqual([...methods].sort(), ['auth.test', 'chat.postMessage', 'conversations.info', 'conversations.members']);
  await app.close();
});

test('what an applicant writes cannot ping people, fake a link or format the message', async () => {
  const { app, slack } = await start();
  const hostile = {
    fullName: '<!channel> *Urgent*',
    city: '<https://evil.example|homology.bio>',
    roleAndOrg: '<@U0REVIEW001> & `code` :tada:',
    workingOn: '<!here> _approve me_ ~now~\n> quoted',
    introWish: '&lt;!everyone&gt; <#C0REVIEW001>',
    canHelpWith: '*bold* <mailto:a@b.co|click>',
    email: '<!channel>@example.org',
  };
  assert.equal((await app.apply(valid(hostile))).status, 200);
  const { blocks, text } = slack.of('chat.postMessage')[0].args;

  const marked = [text, ...texts(blocks, 'mrkdwn')].join('\n');
  for (const value of Object.values(hostile)) {
    for (const piece of ['<!channel', '<!here', '<!everyone', '<@U', '<#C', '<http', '<mailto', 'evil.example', 'Urgent', 'approve me', ':tada:']) {
      if (value.includes(piece)) assert.ok(!marked.includes(piece), `"${piece}" must not reach Slack markup`);
    }
  }
  const seen = shown(blocks);
  for (const value of Object.values(hostile)) assert.ok(seen.includes(value), 'kept exactly as written');
  assert.ok(seen.includes(hostile.workingOn), 'line breaks are kept');

  const plainObjects = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return undefined;
    if (node.type === 'plain_text') plainObjects.push(node);
    return Object.values(node).forEach(walk);
  };
  walk(blocks);
  assert.ok(plainObjects.every((o) => o.emoji === false), 'emoji codes are not converted');
  const rich = blocks.filter((b) => b.type === 'rich_text').flatMap((b) => b.elements).flatMap((section) => section.elements);
  assert.equal(rich.length, 3, 'one literal block per answer');
  assert.ok(rich.every((e) => e.type === 'text' && e.style === undefined && e.url === undefined), 'only literal text, no links or styling');
  assert.equal((await only(app)).answers.fullName, hostile.fullName, 'stored exactly as written');
  await app.close();
});

test('a link button never points anywhere an applicant chose, except their LinkedIn profile', () => {
  const app = newApplication({ ...valid(), linkedinUrl: 'https://evil.example/in/someone' }, '2026-11-19T15:00:00.000Z', '0b0f6c1e-3b1a-4c53-9d4e-2f6a1c7d8e90');
  const { blocks } = applicationMessage(app, { reviewUrl: 'https://review.example.org/review', invitesUrl: 'https://homologybio.slack.com/admin/invites' });
  const urls = blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements).filter((e) => e.url).map((e) => e.url);
  assert.deepEqual(urls, ['https://review.example.org/review']);
  assert.ok(blocks.length <= 50, 'within Slack\'s limit of 50 blocks');
});

test('answers are not posted to a public channel', async () => {
  const { app, slack } = await start({ isPrivate: false });
  assert.equal((await app.apply(valid())).status, 200);
  const sent = JSON.stringify(slack.of('chat.postMessage')[0].args);
  for (const value of Object.values(valid())) assert.ok(!sent.includes(value.split('\n')[0]), 'no answer leaves the service');
  assert.match(sent, /this channel is not private/);
  assert.match(sent, /https:\/\/review\.example\.org\/review/);
  assert.equal((await only(app)).slack.full, false);

  // While the channel stays public, later changes leave that short notice alone.
  const doc = await only(app);
  await app.call('POST', `/api/applications/${doc.id}/status`, { body: { status: 'approved' }, cookie: app.cookieFor(ADMIN) });
  assert.equal(slack.of('chat.update').length, 0);
  assert.equal(slack.of('chat.postMessage').length, 1);

  // Once the channel is private, the next change replaces the notice with the application.
  slack.state.isPrivate = true;
  await app.call('POST', `/api/applications/${doc.id}/notes`, { body: { text: 'Channel fixed.' }, cookie: app.cookieFor(ADMIN) });
  const updates = slack.of('chat.update');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].args.ts, doc.slack.ts);
  assert.ok(shown(updates[0].args.blocks).includes(valid().fullName));
  assert.equal((await only(app)).slack.full, true);
  assert.equal(slack.of('chat.postMessage').length, 1);
  await app.close();
});

test('a message deleted in Slack is posted again on the next change', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const { id } = await only(app);
  slack.state.fail = { 'chat.update': 'message_not_found' };
  await send(app, press('status_approved', id));
  const posts = slack.of('chat.postMessage');
  assert.equal(posts.length, 2);
  assert.match(texts(posts[1].args.blocks, 'mrkdwn').join('\n'), /\*Approved\* by reviewer@example\.org/);
  const doc = await only(app);
  assert.equal(doc.status, 'approved');
  assert.equal(doc.slack.ts, '1795000000.000002');
  await app.close();
});

test('answers are not posted when the channel includes anyone who is not a reviewer', async () => {
  for (const options of [
    { members: [REVIEWER, SECOND_REVIEWER, BOT, MEMBER] },
    { members: [REVIEWER, BOT, 'U0OTHERBOT1'] },
    { shared: true },
    { fail: { 'conversations.members': 'missing_scope' } },
    { fail: { 'conversations.info': 'network' } },
  ]) {
    const { app, slack } = await start(options);
    assert.equal((await app.apply(valid())).status, 200);
    const posts = slack.of('chat.postMessage');
    assert.equal(posts.length, 1, JSON.stringify(options));
    const sent = JSON.stringify(posts[0].args);
    for (const value of Object.values(valid())) assert.ok(!sent.includes(value.split('\n')[0]), JSON.stringify(options));
    assert.equal((await only(app)).slack.full, false);
    await app.close();
  }
});

test('a reviewer removed from ADMIN_EMAILS counts as an outsider in the channel', async () => {
  const { app, slack } = await start();
  app.cfg.adminEmails.splice(app.cfg.adminEmails.indexOf(SECOND_ADMIN), 1);
  await app.apply(valid());
  assert.match(JSON.stringify(slack.of('chat.postMessage')[0].args), /not reviewers/);
  await app.close();
});

test('an application is saved and acknowledged even when Slack is down', async () => {
  for (const fail of [{ 'chat.postMessage': 'network' }, { 'chat.postMessage': 'not_in_channel' }]) {
    const { app } = await start({ fail });
    const res = await app.apply(valid());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, message: THANKS });
    const doc = await only(app);
    assert.equal(doc.status, 'pending');
    assert.equal(doc.slack, undefined);
    assert.ok(app.logs.some((l) => l.includes('"slack.failed"')));
    await app.close();
  }
});

test('an application Slack missed is posted the next time it changes', async () => {
  const { app, slack } = await start({ fail: { 'chat.postMessage': 'not_in_channel' } });
  await app.apply(valid());
  const doc = await only(app);
  slack.state.fail = {};
  await app.call('POST', `/api/applications/${doc.id}/notes`, { body: { text: 'Met at the dinner.' }, cookie: app.cookieFor(ADMIN) });
  const posts = slack.of('chat.postMessage');
  assert.equal(posts.length, 2);
  assert.ok(shown(posts[1].args.blocks).includes('Met at the dinner.'));
  assert.equal((await only(app)).slack.full, true);
  await app.close();
});

// ---------- who may press the buttons ----------

test('a button press without a valid Slack signature changes nothing', async () => {
  const { app } = await start();
  await app.apply(valid());
  const doc = await only(app);
  const payload = press('status_approved', doc.id);
  const attempts = [
    { signed: false },
    { secret: 'not-the-secret' },
    { signature: 'v0=' + '0'.repeat(64) },
    { at: app.clock.t - 6 * 60_000 },
    { at: app.clock.t + 6 * 60_000 },
  ];
  for (const attempt of attempts) {
    const res = await send(app, payload, attempt);
    assert.equal(res.status, 401, JSON.stringify(attempt));
  }
  const after = await only(app);
  assert.equal(after.status, 'pending');
  assert.equal(after.review, null);
  assert.equal(after.history.length, 1);
  await app.close();
});

test('a signed press from another workspace or another channel changes nothing', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const doc = await only(app);
  const elsewhere = [
    press('status_approved', doc.id, { team: { id: 'T0SOMEWHERE' } }),
    press('status_approved', doc.id, { team: undefined }),
    press('status_approved', doc.id, { container: { type: 'message', channel_id: 'C0GENERAL01' } }),
    press('status_approved', doc.id, { container: undefined }),
  ];
  for (const payload of elsewhere) assert.equal((await send(app, payload)).status, 403);
  assert.equal((await only(app)).status, 'pending');
  assert.equal(slack.of('chat.update').length, 0);
  await app.close();
});

test('someone who is not a reviewer cannot decide, and is told so privately', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const doc = await only(app);
  for (const action of ['status_approved', 'status_declined', 'inv_sent', 'notes_edit']) {
    const res = await send(app, press(action, doc.id, { user: { id: MEMBER } }));
    assert.equal(res.status, 200);
  }
  const after = await only(app);
  assert.equal(after.status, 'pending');
  assert.equal(after.history.length, 1);
  assert.equal(slack.of('chat.update').length, 0);
  assert.equal(slack.of('views.open').length, 0);
  assert.equal(slack.state.whispers.length, 4);
  assert.equal(slack.state.whispers[0].response_type, 'ephemeral');
  assert.equal(slack.state.whispers[0].replace_original, false);
  assert.match(slack.state.whispers[0].text, /not set up to review.*U0MEMBER999/);
  await app.close();
});

test('removing a reviewer from ADMIN_EMAILS stops their Slack buttons at once', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const doc = await only(app);
  app.cfg.adminEmails.splice(app.cfg.adminEmails.indexOf(SECOND_ADMIN), 1);
  await send(app, press('status_approved', doc.id, { user: { id: SECOND_REVIEWER } }));
  assert.equal((await only(app)).status, 'pending');
  assert.match(slack.state.whispers[0].text, /not set up to review/);
  await app.close();
});

// ---------- deciding in Slack ----------

test('a reviewer can approve in Slack: recorded with who and when, and nobody is invited', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const doc = await only(app);
  app.clock.t += 60_000;
  const res = await send(app, press('status_approved', doc.id));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');

  const after = await only(app);
  assert.equal(after.status, 'approved');
  assert.deepEqual(after.review, { by: ADMIN, at: '2026-11-19T15:01:00.000Z' });
  assert.deepEqual(after.history.at(-1), { at: '2026-11-19T15:01:00.000Z', by: ADMIN, action: 'status', from: 'pending', to: 'approved', via: 'slack' });
  assert.equal(after.invitation.status, 'not_sent', 'approval invites nobody');
  assert.deepEqual(after.answers, doc.answers);

  const updates = slack.of('chat.update');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].args.channel, CHANNEL);
  assert.equal(updates[0].args.ts, doc.slack.ts, 'the message the service posted, not one named in the request');
  assert.equal(updates[0].args.text, 'Homology application: approved');
  const said = texts(updates[0].args.blocks, 'mrkdwn').join('\n');
  assert.match(said, /\*Approved\* by reviewer@example\.org/);
  assert.match(said, /Approving adds nobody to Slack/);
  assert.match(said, /Never use a shared invite link/);
  assert.deepEqual(buttons(updates[0].args.blocks), ['link_welcome_email', 'email_welcome_sent', 'link_invites', 'inv_sent', 'status_declined', 'status_pending', 'notes_edit', 'link_profile', 'link_review']);
  const invites = updates[0].args.blocks.flatMap((b) => b.elements || []).find((e) => e.action_id === 'link_invites');
  assert.equal(invites.url, 'https://homologybio.slack.com/admin/invites');

  const methods = new Set(slack.state.calls.map((c) => c.method));
  assert.ok(![...methods].some((m) => /invite|admin\.|users\./.test(m)), 'no call that could invite anyone');
  assert.equal(slack.state.whispers.length, 0);
  await app.close();
});

test('declining, moving back and approving all work from Slack', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const { id } = await only(app);
  await send(app, press('status_declined', id, { user: { id: SECOND_REVIEWER } }));
  let doc = await only(app);
  assert.equal(doc.status, 'declined');
  assert.equal(doc.review.by, SECOND_ADMIN);
  assert.deepEqual(buttons(slack.of('chat.update').at(-1).args.blocks).slice(0, 4), ['link_decline_email', 'email_decline_sent', 'status_approved', 'status_pending']);

  await send(app, press('status_pending', id));
  doc = await only(app);
  assert.equal(doc.status, 'pending');
  assert.match(texts(slack.of('chat.update').at(-1).args.blocks, 'mrkdwn').join('\n'), /\*Pending review\* \(moved back by reviewer@example\.org/);

  await send(app, press('status_approved', id));
  assert.equal((await only(app)).status, 'approved');
  assert.equal((await only(app)).history.length, 4);
  await app.close();
});

test('an invitation can only be recorded after approval, and then locks the decision', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const { id } = await only(app);

  // Not approved yet: a press that asks to record an invitation is refused.
  for (const action of ['inv_sent', 'inv_joined']) await send(app, press(action, id));
  let doc = await only(app);
  assert.equal(doc.invitation.status, 'not_sent');
  assert.equal(doc.history.length, 1);
  assert.match(slack.state.whispers[0].text, /Only approved applicants can be invited to Slack/);

  await send(app, press('status_declined', id));
  await send(app, press('inv_sent', id));
  assert.equal((await only(app)).invitation.status, 'not_sent', 'not for a declined application either');

  await send(app, press('status_approved', id));
  app.clock.t += 120_000;
  await send(app, press('inv_sent', id, { user: { id: SECOND_REVIEWER } }));
  doc = await only(app);
  assert.equal(doc.invitation.status, 'sent');
  assert.equal(doc.invitation.sentBy, SECOND_ADMIN);
  assert.equal(doc.invitation.method, 'manual');
  assert.equal(doc.history.at(-1).via, 'slack');
  let latest = slack.of('chat.update').at(-1).args.blocks;
  assert.deepEqual(buttons(latest).slice(0, 4), ['link_welcome_email', 'email_welcome_sent', 'inv_joined', 'inv_clear']);
  assert.ok(!buttons(latest).some((id) => id.startsWith('status_')), 'no decision buttons while locked');
  assert.match(texts(latest, 'mrkdwn').join('\n'), /decision is locked/);

  // Locked: the decision cannot change while the invitation is on record.
  const whispersBefore = slack.state.whispers.length;
  for (const action of ['status_declined', 'status_pending']) await send(app, press(action, id));
  doc = await only(app);
  assert.equal(doc.status, 'approved');
  assert.equal(slack.state.whispers.length, whispersBefore + 2);
  assert.match(slack.state.whispers.at(-1).text, /Revoke it in Slack and clear the record/);

  await send(app, press('inv_joined', id));
  assert.equal((await only(app)).invitation.status, 'joined');
  await send(app, press('inv_clear', id));
  await send(app, press('status_declined', id));
  doc = await only(app);
  assert.equal(doc.invitation.status, 'not_sent');
  assert.equal(doc.status, 'declined');
  latest = slack.of('chat.update').at(-1).args.blocks;
  assert.ok(!texts(latest, 'mrkdwn').join('\n').includes('Slack invitation'));
  await app.close();
});

test('a decision made in the review view updates the Slack message', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const doc = await only(app);
  const res = await app.call('POST', `/api/applications/${doc.id}/status`, { body: { status: 'declined' }, cookie: app.cookieFor(SECOND_ADMIN) });
  assert.equal(res.status, 200);
  const updates = slack.of('chat.update');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].args.ts, doc.slack.ts);
  assert.match(texts(updates[0].args.blocks, 'mrkdwn').join('\n'), /\*Declined\* by second\.reviewer@example\.org/);
  assert.equal((await only(app)).history.at(-1).via, undefined);
  assert.equal(slack.of('chat.postMessage').length, 1, 'no second post');
  await app.close();
});

test('the review view keeps working when Slack is down', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const doc = await only(app);
  slack.state.fail = { 'chat.update': 'network' };
  const res = await app.call('POST', `/api/applications/${doc.id}/status`, { body: { status: 'approved' }, cookie: app.cookieFor(ADMIN) });
  assert.equal(res.status, 200);
  assert.equal((await only(app)).status, 'approved');
  await app.close();
});

// ---------- notes ----------

test('notes can be written from Slack and stay attributed', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const { id } = await only(app);

  assert.equal((await send(app, press('notes_edit', id))).status, 200);
  const opened = slack.of('views.open');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].args.trigger_id, 'trigger.made-up');
  const view = opened[0].args.view;
  assert.equal(view.callback_id, 'notes_save');
  assert.equal(view.private_metadata, id);
  assert.equal(view.blocks[1].element.initial_value, undefined);

  const submit = (text, over = {}) => ({
    type: 'view_submission',
    team: { id: TEAM },
    user: { id: SECOND_REVIEWER },
    view: { callback_id: 'notes_save', private_metadata: id, state: { values: { notes: { text: { type: 'plain_text_input', value: text } } } } },
    ...over,
  });

  app.clock.t += 30_000;
  const saved = await send(app, submit('Strong on single-cell.\n<!channel> should meet *Dana*.'));
  assert.equal(saved.status, 200);
  assert.equal(await saved.text(), '');
  let doc = await only(app);
  assert.deepEqual(doc.notes, { text: 'Strong on single-cell.\n<!channel> should meet *Dana*.', updatedBy: SECOND_ADMIN, updatedAt: '2026-11-19T15:00:30.000Z' });
  assert.deepEqual(doc.history.at(-1), { at: '2026-11-19T15:00:30.000Z', by: SECOND_ADMIN, action: 'notes', via: 'slack' });
  assert.equal(doc.status, 'pending');

  const latest = slack.of('chat.update').at(-1).args.blocks;
  assert.ok(shown(latest).includes(doc.notes.text));
  assert.ok(!texts(latest, 'mrkdwn').join('\n').includes('<!channel>'));
  assert.ok(buttons(latest).includes('notes_edit'));

  // Opening it again starts from the saved note.
  await send(app, press('notes_edit', id));
  assert.equal(slack.of('views.open').at(-1).args.view.blocks[1].element.initial_value, doc.notes.text);

  // Clearing it.
  await send(app, submit(null));
  doc = await only(app);
  assert.equal(doc.notes.text, '');

  // Someone who is not a reviewer cannot save one.
  const refused = await send(app, submit('hello', { user: { id: MEMBER } }));
  assert.deepEqual(await refused.json(), { response_action: 'errors', errors: { notes: 'You are not set up to review Homology applications.' } });
  assert.equal((await only(app)).notes.text, '');
  const elsewhere = await send(app, submit('hello', { team: { id: 'T0SOMEWHERE' } }));
  assert.equal(elsewhere.status, 403);
  await app.close();
});

test('a note too long for Slack is edited in the review view instead', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const { id } = await only(app);
  const long = 'n'.repeat(3500);
  await app.call('POST', `/api/applications/${id}/notes`, { body: { text: long }, cookie: app.cookieFor(ADMIN) });
  const cut = shown(slack.of('chat.update').at(-1).args.blocks).find((t) => t.startsWith('nnn'));
  assert.ok(cut.length <= 3000);
  assert.match(cut, /The rest is in the review view/);
  await send(app, press('notes_edit', id));
  assert.equal(slack.of('views.open').length, 0);
  assert.match(slack.state.whispers.at(-1).text, /too long to edit in Slack/);
  assert.equal((await only(app)).notes.text, long, 'untouched');
  await app.close();
});

// ---------- odds and ends ----------

test('opening a link button, an unknown button or an unknown application changes nothing', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const { id } = await only(app);
  assert.equal((await send(app, press('link_review', id))).status, 200);
  assert.equal((await send(app, press('link_profile', ''))).status, 200);
  assert.equal((await send(app, press('grant_access', id))).status, 400);
  assert.equal((await send(app, press('status_approved', '../../etc'))).status, 400);
  assert.equal((await send(app, press('status_approved', '0b0f6c1e-3b1a-4c53-9d4e-2f6a1c7d8e90'))).status, 200);
  assert.match(slack.state.whispers.at(-1).text, /no longer exists/);
  assert.equal((await send(app, { type: 'shortcut', team: { id: TEAM }, user: { id: REVIEWER } })).status, 200);
  const doc = await only(app);
  assert.equal(doc.status, 'pending');
  assert.equal(doc.history.length, 1);
  assert.equal(slack.of('chat.update').length, 0);

  const bad = await fetch(app.base + '/api/slack/interactions', { method: 'GET' });
  assert.equal(bad.status, 404);
  await app.close();
});

test('logs never contain what applicants or reviewers wrote', async () => {
  const { app } = await start({ fail: { 'chat.update': 'channel_not_found' } });
  await app.apply(valid());
  const { id } = await only(app);
  await send(app, press('status_approved', id));
  await send(app, press('status_approved', id, { user: { id: MEMBER } }));
  await send(app, {
    type: 'view_submission',
    team: { id: TEAM },
    user: { id: REVIEWER },
    view: { callback_id: 'notes_save', private_metadata: id, state: { values: { notes: { text: { value: 'A private remark.' } } } } },
  });
  const all = app.logs.join('\n');
  for (const value of [...Object.values(valid()), 'A private remark.', SLACK.SLACK_BOT_TOKEN, SECRET]) {
    assert.ok(!all.toLowerCase().includes(value.split('\n')[0].toLowerCase()), `log must not contain "${value.slice(0, 20)}"`);
  }
  assert.ok(all.includes('"slack.failed"'));
  assert.ok(all.includes('"slack.refused"'));
  await app.close();
});

// ---------- the intro call ----------

test('a reviewer can move an application to a call from Slack and record the invite', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const { id } = await only(app);

  // The call invite cannot be recorded before the application is at the call stage.
  await send(app, press('call_sent', id));
  assert.equal((await only(app)).call.inviteSentAt, null);
  assert.match(slack.state.whispers.at(-1).text, /Move this application to the call stage/);

  app.clock.t += 60_000;
  assert.equal((await send(app, press('status_call', id))).status, 200);
  let doc = await only(app);
  assert.equal(doc.status, 'call');
  assert.deepEqual(doc.review, { by: ADMIN, at: '2026-11-19T15:01:00.000Z' });
  assert.deepEqual(doc.history.at(-1), { at: '2026-11-19T15:01:00.000Z', by: ADMIN, action: 'status', from: 'pending', to: 'call', via: 'slack' });
  assert.equal(doc.invitation.status, 'not_sent', 'a call invites nobody to Slack');

  let latest = slack.of('chat.update').at(-1).args;
  assert.equal(latest.text, 'Homology application: intro call');
  assert.deepEqual(buttons(latest.blocks), ['link_call_invite', 'call_sent', 'status_approved', 'status_declined', 'status_pending', 'notes_edit', 'link_profile', 'link_review']);
  let said = texts(latest.blocks, 'mrkdwn').join('\n');
  assert.match(said, /\*Intro call\* \(moved to a call by reviewer@example\.org/);
  assert.match(said, /\*Call invite:\* not sent/);
  assert.ok(!said.includes('Slack invitation'), 'no Slack invitation step at the call stage');

  // The draft button opens Gmail, addressed to the applicant, and nothing else.
  const draft = latest.blocks.flatMap((b) => b.elements || []).find((e) => e.action_id === 'link_call_invite');
  const url = new URL(draft.url);
  assert.equal(url.origin + url.pathname, 'https://mail.google.com/mail/');
  assert.equal(url.searchParams.get('to'), 'Test.Applicant@example.org');
  assert.equal(url.searchParams.get('su'), 'Homology | quick intro call');
  assert.match(url.searchParams.get('body'), /^Hi Test,\n/);
  assert.equal(url.searchParams.get('authuser'), null, 'the Slack message is shared, so it names no account');
  assert.ok(draft.url.length <= 3000);
  assert.equal((await send(app, press('link_call_invite', id))).status, 200, 'opening the draft records nothing');
  assert.equal((await only(app)).call.inviteSentAt, null);

  // Someone who is not a reviewer cannot record it.
  await send(app, press('call_sent', id, { user: { id: MEMBER } }));
  assert.equal((await only(app)).call.inviteSentAt, null);

  app.clock.t += 60_000;
  await send(app, press('call_sent', id, { user: { id: SECOND_REVIEWER } }));
  doc = await only(app);
  assert.deepEqual(doc.call, { inviteSentBy: SECOND_ADMIN, inviteSentAt: '2026-11-19T15:02:00.000Z' });
  assert.deepEqual(doc.history.at(-1), { at: '2026-11-19T15:02:00.000Z', by: SECOND_ADMIN, action: 'call_invite', from: 'not_sent', to: 'sent', via: 'slack' });
  assert.equal(doc.status, 'call');
  latest = slack.of('chat.update').at(-1).args;
  assert.deepEqual(buttons(latest.blocks).slice(0, 4), ['status_approved', 'status_declined', 'status_pending', 'call_clear']);
  assert.match(texts(latest.blocks, 'mrkdwn').join('\n'), /\*Call invite:\* sent, recorded by second\.reviewer@example\.org.*After the call, add what you learned/);

  // Clearing and recording again.
  await send(app, press('call_clear', id));
  assert.equal((await only(app)).call.inviteSentAt, null);
  await send(app, press('call_sent', id));
  await send(app, press('call_sent', id));
  assert.match(slack.state.whispers.at(-1).text, /already on record/);

  // After the call: approve. Only now does the Slack invitation step appear.
  await send(app, press('inv_sent', id));
  assert.equal((await only(app)).invitation.status, 'not_sent', 'a call is not an approval');
  await send(app, press('status_approved', id));
  doc = await only(app);
  assert.equal(doc.status, 'approved');
  latest = slack.of('chat.update').at(-1).args;
  said = texts(latest.blocks, 'mrkdwn').join('\n');
  assert.match(said, /\*Approved\* by reviewer@example\.org/);
  assert.match(said, /\*Call invite:\* sent, recorded by reviewer@example\.org/);
  assert.match(said, /\*Slack invitation:\* not sent/);
  assert.deepEqual(buttons(latest.blocks).slice(0, 6), ['link_welcome_email', 'email_welcome_sent', 'link_invites', 'inv_sent', 'status_declined', 'status_pending']);
  await app.close();
});

test('the call can be skipped or end in a decline, from Slack', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  await app.apply(valid({ email: 'second@example.org' }));
  const [a, b] = await app.store.list();

  await send(app, press('status_approved', a.id));
  assert.equal((await app.store.get(a.id)).status, 'approved', 'approved without a call');
  assert.equal((await app.store.get(a.id)).call.inviteSentAt, null);

  await send(app, press('status_call', b.id));
  await send(app, press('status_declined', b.id));
  const declined = await app.store.get(b.id);
  assert.equal(declined.status, 'declined');
  assert.deepEqual(buttons(slack.of('chat.update').at(-1).args.blocks).slice(0, 4), ['link_decline_email', 'email_decline_sent', 'status_approved', 'status_pending']);
  await app.close();
});

test('with a booking link set, the Slack draft carries it', async () => {
  const { app, slack } = await start({}, { CALL_BOOKING_URL: 'https://cal.example.org/homology/intro' });
  await app.apply(valid());
  const { id } = await only(app);
  await send(app, press('status_call', id));
  const draft = slack.of('chat.update').at(-1).args.blocks.flatMap((b) => b.elements || []).find((e) => e.action_id === 'link_call_invite');
  assert.match(new URL(draft.url).searchParams.get('body'), /pick a time here:\nhttps:\/\/cal\.example\.org\/homology\/intro\n/);
  await app.close();
});

// ---------- the welcome and decline emails ----------

const styles = (blocks) =>
  Object.fromEntries(blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements).map((e) => [e.action_id, e.style || '']));
const rows = (blocks) => blocks.filter((b) => b.type === 'actions').map((b) => b.block_id);
const draftButton = (blocks, id) => new URL(blocks.flatMap((b) => b.elements || []).find((e) => e.action_id === id).url);

test('after approving in Slack, the welcome email comes first and then the invitation', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const { id } = await only(app);

  // No email can be recorded before a decision.
  for (const action of ['email_welcome_sent', 'email_decline_sent']) await send(app, press(action, id));
  assert.equal((await only(app)).emails.welcome.sentAt, null);
  assert.match(slack.state.whispers.at(-1).text, /can only be recorded for a declined application/);

  await send(app, press('status_approved', id));
  let latest = slack.of('chat.update').at(-1).args.blocks;
  assert.deepEqual(rows(latest), ['step', 'invite', 'decide', 'more']);
  assert.deepEqual(buttons(latest), ['link_welcome_email', 'email_welcome_sent', 'link_invites', 'inv_sent', 'status_declined', 'status_pending', 'notes_edit', 'link_profile', 'link_review']);
  assert.equal(styles(latest).email_welcome_sent, 'primary');
  assert.equal(styles(latest).inv_sent, '', 'only one button stands out');
  let said = texts(latest, 'mrkdwn').join('\n');
  assert.match(said, /\*Welcome email:\* not sent/);
  assert.ok(!said.includes('Decline email'));

  const draft = draftButton(latest, 'link_welcome_email');
  assert.equal(draft.origin + draft.pathname, 'https://mail.google.com/mail/');
  assert.equal(draft.searchParams.get('to'), 'Test.Applicant@example.org');
  assert.equal(draft.searchParams.get('su'), 'Welcome to Homology');
  assert.equal(draft.searchParams.get('authuser'), null);
  assert.equal((await send(app, press('link_welcome_email', id))).status, 200, 'opening the draft records nothing');
  assert.equal((await only(app)).emails.welcome.sentAt, null);

  // The wrong email for this decision, and someone who is not a reviewer.
  await send(app, press('email_decline_sent', id));
  await send(app, press('email_welcome_sent', id, { user: { id: MEMBER } }));
  assert.deepEqual((await only(app)).emails, { welcome: { sentBy: null, sentAt: null }, decline: { sentBy: null, sentAt: null } });

  app.clock.t += 60_000;
  await send(app, press('email_welcome_sent', id, { user: { id: SECOND_REVIEWER } }));
  const doc = await only(app);
  assert.deepEqual(doc.emails.welcome, { sentBy: SECOND_ADMIN, sentAt: '2026-11-19T15:01:00.000Z' });
  assert.deepEqual(doc.history.at(-1), { at: '2026-11-19T15:01:00.000Z', by: SECOND_ADMIN, action: 'email', kind: 'welcome', from: 'not_sent', to: 'sent', via: 'slack' });
  assert.equal(doc.invitation.status, 'not_sent', 'a welcome email invites nobody');

  latest = slack.of('chat.update').at(-1).args.blocks;
  assert.deepEqual(rows(latest), ['invite', 'decide', 'more']);
  assert.deepEqual(buttons(latest).slice(0, 4), ['link_invites', 'inv_sent', 'status_declined', 'status_pending']);
  assert.equal(styles(latest).inv_sent, 'primary', 'now the invitation is the next step');
  assert.match(texts(latest, 'mrkdwn').join('\n'), /\*Welcome email:\* sent, recorded by second\.reviewer@example\.org/);

  await send(app, press('email_welcome_sent', id));
  assert.match(slack.state.whispers.at(-1).text, /already on record/);
  await app.close();
});

test('after declining in Slack, the decline email is the one step left', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const { id } = await only(app);
  await send(app, press('status_declined', id));
  let latest = slack.of('chat.update').at(-1).args.blocks;
  assert.deepEqual(rows(latest), ['step', 'decide', 'more']);
  assert.deepEqual(buttons(latest).slice(0, 4), ['link_decline_email', 'email_decline_sent', 'status_approved', 'status_pending']);
  assert.equal(styles(latest).email_decline_sent, 'primary');
  assert.equal(draftButton(latest, 'link_decline_email').searchParams.get('su'), 'Your Homology application');
  let said = texts(latest, 'mrkdwn').join('\n');
  assert.match(said, /\*Decline email:\* not sent/);
  assert.ok(!said.includes('Welcome email') && !said.includes('Slack invitation'));

  await send(app, press('email_decline_sent', id));
  assert.equal((await only(app)).emails.decline.sentBy, ADMIN);
  latest = slack.of('chat.update').at(-1).args.blocks;
  assert.deepEqual(rows(latest), ['decide', 'more']);
  assert.deepEqual(buttons(latest).slice(0, 2), ['status_approved', 'status_pending']);

  // A change of heart: the decline email still went out, and the message keeps saying so.
  await send(app, press('status_approved', id));
  latest = slack.of('chat.update').at(-1).args.blocks;
  said = texts(latest, 'mrkdwn').join('\n');
  assert.match(said, /\*Decline email:\* sent, recorded by reviewer@example\.org/);
  assert.match(said, /\*Welcome email:\* not sent/);
  assert.deepEqual(buttons(latest).slice(0, 2), ['link_welcome_email', 'email_welcome_sent']);
  await app.close();
});

test('an email recorded in the review view shows up in Slack', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  const { id } = await only(app);
  const cookie = app.cookieFor(ADMIN);
  await app.call('POST', `/api/applications/${id}/status`, { cookie, body: { status: 'approved' } });
  await app.call('POST', `/api/applications/${id}/email`, { cookie, body: { kind: 'welcome', action: 'sent' } });
  let said = texts(slack.of('chat.update').at(-1).args.blocks, 'mrkdwn').join('\n');
  assert.match(said, /\*Welcome email:\* sent, recorded by reviewer@example\.org/);
  assert.equal((await only(app)).history.at(-1).via, undefined);

  // Cleared in the review view: Slack offers the step again.
  await app.call('POST', `/api/applications/${id}/email`, { cookie, body: { kind: 'welcome', action: 'clear' } });
  const latest = slack.of('chat.update').at(-1).args.blocks;
  assert.deepEqual(buttons(latest).slice(0, 2), ['link_welcome_email', 'email_welcome_sent']);
  await app.close();
});

// ---------- the receipt ----------

test('the Slack post says when the applicant was emailed a receipt', async () => {
  const slack = fakeSlack();
  const order = [];
  const mailFetch = async (url, init) => {
    order.push('mail');
    assert.equal(String(url), 'https://api.resend.com/emails');
    assert.deepEqual(JSON.parse(init.body).to, ['Test.Applicant@example.org']);
    return new Response(JSON.stringify({ id: 'made-up-id' }), { status: 200 });
  };
  const slackFetch = async (url, init) => {
    if (String(url).endsWith('/chat.postMessage')) order.push('slack');
    return slack.fetchImpl(url, init);
  };
  const app = await boot(
    { ...SLACK, RESEND_API_KEY: 're_made_up_key_for_tests', EMAIL_FROM: 'Homology <hello@homology.bio>' },
    { slackFetch, mailFetch },
  );
  await app.apply(valid());
  assert.deepEqual(order, ['mail', 'slack'], 'the receipt goes out first, so the post can say so');
  const posted = slack.of('chat.postMessage')[0].args;
  assert.match(texts(posted.blocks, 'mrkdwn').join('\n'), /Applied <!date\^\d+\^[^>]+>\. Receipt emailed to them\./);
  assert.equal(posted.text, 'New Homology application');
  const doc = await only(app);
  assert.equal(doc.receipt.sentAt, '2026-11-19T15:00:00.000Z');
  assert.equal(doc.slack.full, true, 'both records are kept');
  await app.close();
});

test('without a receipt the Slack post does not claim one', async () => {
  const { app, slack } = await start();
  await app.apply(valid());
  assert.ok(!texts(slack.of('chat.postMessage')[0].args.blocks, 'mrkdwn').join('\n').includes('Receipt'));
  await app.close();
});
