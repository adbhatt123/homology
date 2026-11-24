// The form's hidden field (the spam check).
//
// The rule: nothing a person might have sent is ever dropped out of sight.
// An application that fills in the hidden field is saved like any other,
// marked for a reviewer, and sent no receipt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { THANKS, TRAP_FIELDS } from '../src/server.js';
import { SPAM_CHECK_LINE, applicationMessage } from '../src/slack.js';
import { newApplication, spamCheckOf } from '../src/applications.js';
import { ADMIN, SECOND_ADMIN, SITE, boot, valid } from './helpers.js';

const only = async (app) => (await app.store.list())[0];
const events = (app) => app.logs.map((l) => JSON.parse(l));

// ---------- the rule itself ----------

test('a new application is not marked unless the hidden field was filled in', () => {
  const plain = newApplication(valid(), '2026-11-19T15:00:00.000Z', 'id-1');
  assert.deepEqual(plain.spamCheck, { tripped: false });
  assert.deepEqual(plain.history, [{ at: '2026-11-19T15:00:00.000Z', by: 'applicant', action: 'submitted' }]);

  const marked = newApplication(valid(), '2026-11-19T15:00:00.000Z', 'id-2', { spamCheck: true });
  assert.deepEqual(marked.spamCheck, { tripped: true });
  assert.equal(marked.status, 'pending');
  assert.deepEqual(marked.history, [{ at: '2026-11-19T15:00:00.000Z', by: 'applicant', action: 'submitted', spamCheck: 'tripped' }]);
});

test('an application saved before the spam check was recorded reads as not marked', () => {
  const old = newApplication(valid(), '2026-11-19T15:00:00.000Z', 'id-1');
  delete old.spamCheck;
  assert.deepEqual(spamCheckOf(old), { tripped: false });
});

// ---------- applying ----------

test('either name of the hidden field marks the application, and it is still saved', async () => {
  assert.deepEqual(TRAP_FIELDS, ['leave_blank', 'company_website']);
  for (const field of TRAP_FIELDS) {
    const app = await boot();
    const res = await app.apply(valid({ [field]: 'Acme Biosciences' }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, message: THANKS });

    const saved = await only(app);
    assert.equal(saved.status, 'pending');
    assert.deepEqual(saved.spamCheck, { tripped: true });
    assert.equal(saved.answers.fullName, 'Test Applicant');
    // What was typed into the hidden field is not kept anywhere.
    assert.ok(!JSON.stringify(saved).includes('Acme Biosciences'));
    assert.ok(!Object.keys(saved.answers).some((k) => TRAP_FIELDS.includes(k)));

    const submitted = events(app).filter((e) => e.event === 'application.submitted');
    assert.deepEqual(submitted.map((e) => e.spamCheck), ['tripped']);
    assert.equal(events(app).filter((e) => e.event === 'application.discarded').length, 0);
    await app.close();
  }
});

test('an empty or blank hidden field marks nothing', async () => {
  const app = await boot({ APPLY_PER_IP: '10' });
  const blanks = ['', '   ', '\n', null, 0, false, {}, []];
  for (const [i, value] of blanks.entries()) {
    assert.equal((await app.apply(valid({ leave_blank: value, company_website: value, email: `a${i}@example.org` }))).status, 200);
  }
  const saved = await app.store.list();
  assert.equal(saved.length, 8);
  assert.ok(saved.every((a) => a.spamCheck.tripped === false));
  await app.close();
});

test('a filled hidden field does not hide a mistake in the form from the applicant', async () => {
  const app = await boot();
  const res = await app.apply(valid({ leave_blank: 'Acme Biosciences', linkedinUrl: 'not a profile' }));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.errors.linkedinUrl);
  assert.equal((await app.store.list()).length, 0);
  await app.close();
});

test('the plain form post, for a browser without JavaScript, is marked and saved too', async () => {
  const app = await boot();
  const res = await fetch(app.base + '/api/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: SITE },
    body: new URLSearchParams({ ...valid(), leave_blank: 'http://spam.example' }).toString(),
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Application received/);
  assert.deepEqual((await only(app)).spamCheck, { tripped: true });
  await app.close();
});

// ---------- the receipt ----------

test('a marked application gets no receipt email, and an ordinary one still does', async () => {
  const sent = [];
  const mailFetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'made-up-id' }), { status: 200 });
  };
  const app = await boot(
    { RESEND_API_KEY: 're_made_up_key_for_tests', EMAIL_FROM: 'Homology <hello@homology.bio>' },
    { mailFetch },
  );

  assert.equal((await app.apply(valid({ leave_blank: 'Acme Biosciences' }))).status, 200);
  assert.equal(sent.length, 0);
  assert.deepEqual((await only(app)).receipt, { sentAt: null });
  assert.deepEqual(
    events(app).filter((e) => e.event.startsWith('receipt.')).map((e) => [e.event, e.reason]),
    [['receipt.skipped', 'spam_check']],
  );

  assert.equal((await app.apply(valid({ email: 'someone.real@example.org' }))).status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['someone.real@example.org']);
  await app.close();
});

// ---------- what reviewers see ----------

test('the review view is told which applications are marked', async () => {
  const app = await boot();
  await app.apply(valid({ leave_blank: 'Acme Biosciences' }));
  await app.apply(valid({ email: 'second@example.org' }));
  // One saved before the spam check was recorded.
  const old = newApplication(valid({ email: 'old@example.org' }), '2026-11-01T00:00:00.000Z', '00000000-0000-4000-8000-000000000001');
  delete old.spamCheck;
  await app.store.create(old);

  const res = await app.call('GET', '/api/applications', { cookie: app.cookieFor(ADMIN) });
  assert.equal(res.status, 200);
  const byEmail = Object.fromEntries((await res.json()).applications.map((a) => [a.emailKey, a.spamCheck]));
  assert.deepEqual(byEmail, {
    'test.applicant@example.org': { tripped: true },
    'second@example.org': { tripped: false },
    'old@example.org': { tripped: false },
  });
  await app.close();
});

test('a reviewer decides on a marked application like any other', async () => {
  const app = await boot();
  await app.apply(valid({ leave_blank: 'Acme Biosciences' }));
  const { id } = await only(app);
  const res = await app.call('POST', `/api/applications/${id}/status`, { cookie: app.cookieFor(SECOND_ADMIN), body: { status: 'call' } });
  assert.equal(res.status, 200);
  const saved = await only(app);
  assert.equal(saved.status, 'call');
  assert.deepEqual(saved.spamCheck, { tripped: true });
  await app.close();
});

test('the Slack message for a marked application says so, right under the name', () => {
  const options = { reviewUrl: 'https://review.example.org/review', invitesUrl: 'https://example.slack.com/admin/invites' };
  const marked = applicationMessage(newApplication(valid(), '2026-11-19T15:00:00.000Z', 'id-1', { spamCheck: true }), options);
  assert.equal(marked.text, 'New Homology application (check for spam)');
  assert.equal(marked.blocks[0].type, 'header');
  assert.deepEqual(marked.blocks[1], { type: 'section', text: { type: 'mrkdwn', text: SPAM_CHECK_LINE } });
  assert.match(SPAM_CHECK_LINE, /No receipt email was sent/);
  // Slack allows 3,000 characters in a section.
  assert.ok(SPAM_CHECK_LINE.length < 3000);

  const plain = applicationMessage(newApplication(valid(), '2026-11-19T15:00:00.000Z', 'id-2'), options);
  assert.equal(plain.text, 'New Homology application');
  assert.ok(!JSON.stringify(plain.blocks).includes('Check this one'));
  assert.equal(plain.blocks.length, marked.blocks.length - 1);
});

// ---------- the public page ----------

test('the page sends the hidden field under a name the service knows, and hides it from autofill', async () => {
  const page = await readFile(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
  const field = TRAP_FIELDS[0];

  const input = page.match(/<div class="trap"[^>]*>[\s\S]*?<input([^>]*)>/);
  assert.ok(input, 'the page has the hidden field');
  assert.match(input[1], new RegExp(`name="${field}"`));
  assert.match(input[1], /autocomplete="off"/);
  assert.match(input[1], /tabindex="-1"/);
  // Fully hidden: a field moved off screen still counts as visible to a browser's autofill.
  assert.match(page, /\.trap \{ display: none; \}/);
  assert.match(page, new RegExp(`var data = \\{ ${field}: form\\.elements\\.${field}\\.value \\};`));

  // Nothing about the field's name or label invites a browser or password manager to fill it.
  const hints = /name|mail|phone|tel|address|street|city|state|zip|postal|country|company|org|business|site|url|user|login|pass|title|card/i;
  assert.ok(!hints.test(field), `"${field}" looks like something autofill would fill`);
  assert.ok(!page.includes('company_website'));
});
