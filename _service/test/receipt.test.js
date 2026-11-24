import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { receiptEmail } from '../src/emails.js';
import { newApplication } from '../src/applications.js';
import { THANKS } from '../src/server.js';
import { ADMIN, SECOND_ADMIN, boot, valid } from './helpers.js';

const KEY = 're_made_up_key_for_tests';
const MAIL = { RESEND_API_KEY: KEY, EMAIL_FROM: 'Homology <hello@homology.bio>', EMAIL_REPLY_TO: 'reviewer@example.org' };
const only = async (app) => (await app.store.list())[0];

// Stands in for the mail service. Records every send.
function fakeMail({ fail = null } = {}) {
  const state = { fail, sent: [] };
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), 'https://api.resend.com/emails');
    assert.equal(init.method, 'POST');
    state.sent.push({ auth: init.headers.Authorization, body: JSON.parse(init.body) });
    if (state.fail === 'network') throw new Error('network down');
    if (state.fail) return new Response(JSON.stringify({ statusCode: state.fail, name: 'validation_error', message: 'Invalid `to` field: someone@example.org' }), { status: state.fail });
    return new Response(JSON.stringify({ id: 'made-up-id' }), { status: 200 });
  };
  return { state, fetchImpl };
}

async function start(envOver = {}, mailOptions = {}, extra = {}) {
  const mail = fakeMail(mailOptions);
  const app = await boot({ ...MAIL, ...envOver }, { mailFetch: mail.fetchImpl, ...extra });
  return { app, mail };
}

// ---------- settings ----------

test('the receipt is off unless both the key and the sender are set', () => {
  const base = { ADMIN_EMAILS: ADMIN };
  assert.equal(loadConfig(base).cfg.email.enabled, false);
  assert.deepEqual(loadConfig(base).problems, []);
  assert.deepEqual(loadConfig({ ...base, ...MAIL }).problems, []);
  assert.equal(loadConfig({ ...base, ...MAIL }).cfg.email.enabled, true);
  assert.deepEqual(loadConfig({ ...base, RESEND_API_KEY: KEY, EMAIL_FROM: 'hello@homology.bio' }).problems, []);

  assert.match(loadConfig({ ...base, RESEND_API_KEY: KEY }).problems.join(' '), /RESEND_API_KEY and EMAIL_FROM together/);
  assert.match(loadConfig({ ...base, EMAIL_FROM: 'Homology <hello@homology.bio>' }).problems.join(' '), /together/);
  assert.match(loadConfig({ ...base, ...MAIL, EMAIL_FROM: 'Homology' }).problems.join(' '), /EMAIL_FROM must look like/);
  assert.match(loadConfig({ ...base, ...MAIL, EMAIL_FROM: 'A <a@b.co>\r\nBcc: x@y.co' }).problems.join(' '), /EMAIL_FROM must look like/);
  assert.match(loadConfig({ ...base, ...MAIL, EMAIL_REPLY_TO: 'a@b.co, c@d.co' }).problems.join(' '), /EMAIL_REPLY_TO must be one email address/);
  assert.match(loadConfig({ ...base, EMAIL_REPLY_TO: 'a@b.co' }).problems.join(' '), /EMAIL_REPLY_TO is set but the receipt email is not/);
});

test('with the receipt off, applying sends no email', async () => {
  const mail = fakeMail();
  const app = await boot({}, { mailFetch: mail.fetchImpl });
  assert.equal((await app.apply(valid())).status, 200);
  assert.equal(mail.state.sent.length, 0);
  assert.deepEqual((await only(app)).receipt, { sentAt: null });
  const config = await (await fetch(app.base + '/api/config')).json();
  assert.deepEqual(config.receipt, { on: false });
  await app.close();
});

// ---------- sending ----------

test('a saved application gets one short receipt, and the applicant sees the same page as before', async () => {
  const { app, mail } = await start();
  const res = await app.apply(valid({ fullName: 'Jane Okafor-Smith', email: 'Jane+bio@example.org' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, message: THANKS });

  assert.equal(mail.state.sent.length, 1);
  const { auth, body } = mail.state.sent[0];
  assert.equal(auth, `Bearer ${KEY}`);
  assert.deepEqual(Object.keys(body).sort(), ['from', 'reply_to', 'subject', 'text', 'to']);
  assert.equal(body.from, 'Homology <hello@homology.bio>');
  assert.deepEqual(body.to, ['Jane+bio@example.org'], 'one recipient: the address they applied with');
  assert.equal(body.reply_to, 'reviewer@example.org');
  assert.equal(body.subject, 'We got your Homology application');
  assert.equal(
    body.text,
    [
      'Hi Jane,',
      'We got your application to Homology. Thanks for sending it in.',
      "We read every one ourselves, so you'll hear back from us soon. Keep an eye out for an email from us.",
      'Adarsh and Arthur',
    ].join('\n\n'),
  );
  assert.ok(!/[–—]/.test(body.text), 'no em or en dashes');
  assert.ok(!/approved|declined|welcome|slack|http/i.test(body.text), 'it says nothing about the outcome and holds no link');

  const doc = await only(app);
  assert.equal(doc.status, 'pending', 'a receipt decides nothing');
  assert.deepEqual(doc.receipt, { sentAt: '2026-11-19T15:00:00.000Z' });
  assert.deepEqual(doc.history, [
    { at: '2026-11-19T15:00:00.000Z', by: 'applicant', action: 'submitted' },
    { at: '2026-11-19T15:00:00.000Z', by: 'service', action: 'receipt' },
  ]);

  const list = await (await app.call('GET', '/api/applications', { cookie: app.cookieFor(SECOND_ADMIN) })).json();
  assert.deepEqual(list.applications[0].receipt, { sentAt: '2026-11-19T15:00:00.000Z' });
  const config = await (await fetch(app.base + '/api/config')).json();
  assert.deepEqual(config.receipt, { on: true });
  await app.close();
});

test('the receipt carries nothing an applicant typed except a plain first name', async () => {
  const { app, mail } = await start({ APPLY_PER_IP: '100' });
  const hostile = {
    fullName: 'Click https://evil.example now',
    city: 'https://evil.example',
    roleAndOrg: 'Free money at evil.example',
    workingOn: 'Visit evil.example',
    introWish: 'evil.example',
    canHelpWith: 'evil.example',
  };
  await app.apply(valid(hostile));
  await app.apply(valid({ fullName: 'Dr. <b>Bob</b>', email: 'second@example.org' }));
  await app.apply(valid({ fullName: 'Li Wei', email: 'third@example.org', receipt: { sentAt: '2020-01-01T00:00:00.000Z' } }));
  assert.equal(mail.state.sent.length, 3);
  const [a, b, c] = mail.state.sent.map((s) => s.body);
  assert.match(a.text, /^Hi Click,\n\n/, 'a first word made of letters is all that gets through');
  assert.ok(!a.text.includes('evil') && !a.text.includes('http'));
  assert.match(b.text, /^Hi there,\n\n/);
  assert.ok(!b.text.includes('<'));
  assert.match(c.text, /^Hi Li,\n\n/);
  for (const body of [a, b, c]) {
    assert.equal(body.subject, 'We got your Homology application');
    assert.equal(body.from, 'Homology <hello@homology.bio>');
    assert.equal(body.to.length, 1);
  }
  // An applicant cannot claim a receipt was already sent to dodge or fake the record.
  const third = (await app.store.list()).find((d) => d.emailKey === 'third@example.org');
  assert.equal(third.receipt.sentAt, '2026-11-19T15:00:00.000Z');
  await app.close();
});

test('nothing is emailed for a submission that is not saved', async () => {
  const { app, mail } = await start({ APPLY_PER_IP: '3' });
  assert.equal((await app.apply(valid({ email: 'not-an-email' }))).status, 422);
  assert.equal((await app.apply(valid({ workingOn: ' ' }))).status, 422);
  assert.equal((await app.apply(valid(), { Origin: 'https://evil.example' })).status, 403);
  assert.equal(mail.state.sent.length, 0);
  assert.equal((await app.store.list()).length, 0);

  // Past the per-address limit nothing is saved, so nothing is sent.
  for (let i = 0; i < 6; i += 1) await app.apply(valid({ email: `p${i}@example.org` }));
  assert.equal(mail.state.sent.length, (await app.store.list()).length);
  assert.ok(mail.state.sent.length < 6);
  await app.close();
});

test('one address gets at most one receipt a day, however often it is entered', async () => {
  const { app, mail } = await start({ APPLY_PER_IP: '100' });
  await app.apply(valid());
  await app.apply(valid({ email: 'TEST.applicant@example.org' }));
  await app.apply(valid());
  assert.equal((await app.store.list()).length, 3, 'every application is still saved');
  assert.equal(mail.state.sent.length, 1, 'but the address is only emailed once');
  assert.ok(app.logs.some((l) => l.includes('"receipt.skipped"')));

  app.clock.t += 23 * 3600_000;
  await app.apply(valid());
  assert.equal(mail.state.sent.length, 1);

  app.clock.t += 2 * 3600_000;
  await app.apply(valid());
  assert.equal(mail.state.sent.length, 2, 'a day later it is a new application');

  // Someone else is unaffected.
  await app.apply(valid({ email: 'someone.else@example.org' }));
  assert.equal(mail.state.sent.length, 3);
  await app.close();
});

test('an application is saved and acknowledged even when the mail service is down', async () => {
  for (const fail of ['network', 500, 422]) {
    const { app, mail } = await start({}, { fail });
    const res = await app.apply(valid());
    assert.equal(res.status, 200, String(fail));
    assert.deepEqual(await res.json(), { ok: true, message: THANKS });
    assert.equal(mail.state.sent.length, 1);
    const doc = await only(app);
    assert.equal(doc.status, 'pending');
    assert.deepEqual(doc.receipt, { sentAt: null }, 'no receipt is claimed');
    assert.equal(doc.history.length, 1);
    const failure = app.logs.find((l) => l.includes('"receipt.failed"'));
    assert.ok(failure, 'the failure is logged');
    assert.ok(!failure.toLowerCase().includes('example.org'), 'without the address');

    // It is not retried on its own, but a later application from them can get one.
    mail.state.fail = null;
    app.clock.t += 60_000;
    await app.apply(valid());
    assert.equal(mail.state.sent.length, 2);
    await app.close();
  }
});

test('logs never hold the applicant address, the receipt text or the mail key', async () => {
  const { app } = await start();
  await app.apply(valid());
  await app.apply(valid());
  const all = app.logs.join('\n').toLowerCase();
  for (const value of ['test.applicant@example.org', 'test applicant', 'keep an eye out', KEY.toLowerCase(), 'hello@homology.bio']) {
    assert.ok(!all.includes(value), `log must not contain "${value}"`);
  }
  assert.ok(all.includes('"receipt.sent"'));
  await app.close();
});

test('the wording, on its own', () => {
  const app = newApplication({ ...valid(), fullName: 'Jane Smith' }, '2026-11-19T15:00:00.000Z', '0b0f6c1e-3b1a-4c53-9d4e-2f6a1c7d8e90');
  const { to, subject, body } = receiptEmail(app);
  assert.equal(to, 'Test.Applicant@example.org');
  assert.equal(subject, 'We got your Homology application');
  assert.ok(body.startsWith('Hi Jane,\n\nWe got your application to Homology.'));
  assert.ok(body.endsWith('\n\nAdarsh and Arthur'));
  assert.ok(body.length < 400, 'short');
});
