import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createIdTokenVerifier, readSession, signSession } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const CLIENT = 'client-id.apps.googleusercontent.com';
const NOW = Date.parse('2026-11-19T15:00:00Z');
const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = [{ ...google.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(claims = {}, { key = google.privateKey, header = {} } = {}) {
  const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header });
  const p = b64({
    iss: 'https://accounts.google.com',
    aud: CLIENT,
    email: 'Reviewer@Example.org',
    email_verified: true,
    iat: NOW / 1000 - 10,
    exp: NOW / 1000 + 3600,
    ...claims,
  });
  const sig = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key).toString('base64url');
  return `${h}.${p}.${sig}`;
}
const verify = createIdTokenVerifier({ clientId: CLIENT, getKeys: async () => jwks, now: () => NOW });
const fails = (t, code) => assert.rejects(() => verify(t), (e) => e.code === code, code);

test('a genuine Google token for this app is accepted', async () => {
  assert.deepEqual(await verify(token()), { email: 'reviewer@example.org', name: '' });
});

test('tokens that are not genuine are refused', async () => {
  await fails(token({}, { key: attacker.privateKey }), 'bad_signature');
  await fails(token({ aud: 'some-other-app' }), 'wrong_audience');
  await fails(token({ iss: 'https://evil.example' }), 'wrong_issuer');
  await fails(token({ exp: NOW / 1000 - 3600 }), 'expired');
  await fails(token({ email_verified: false }), 'email_not_verified');
  await fails(token({}, { header: { kid: 'unknown' } }), 'unknown_key');
  await fails(token({}, { header: { alg: 'none' } }), 'unsupported_token');
  await fails(token({}, { header: { alg: 'HS256' } }), 'unsupported_token');
  await fails('not-a-token', 'malformed_token');
  const [h, , s] = token().split('.');
  await fails(`${h}.${b64({ aud: CLIENT, iss: 'accounts.google.com', email: 'x@y.org', email_verified: true, exp: NOW / 1000 + 60 })}.${s}`, 'bad_signature');
});

test('session cookies cannot be forged, altered or reused after they expire', () => {
  const secret = 's'.repeat(40);
  const good = signSession('reviewer@example.org', NOW + 1000, secret);
  assert.equal(readSession(`homology_review=${good}`, secret, NOW), 'reviewer@example.org');
  assert.equal(readSession(`other=1; homology_review=${good}`, secret, NOW), 'reviewer@example.org');
  assert.equal(readSession(`homology_review=${good}`, secret, NOW + 2000), null, 'expired');
  assert.equal(readSession(`homology_review=${good}`, 'another-secret'.repeat(4), NOW), null, 'wrong secret');
  const forged = Buffer.from(JSON.stringify({ e: 'attacker@example.org', x: NOW + 1000 })).toString('base64url');
  assert.equal(readSession(`homology_review=${forged}.${good.split('.')[1]}`, secret, NOW), null, 'altered');
  assert.equal(readSession(`homology_review=${forged}`, secret, NOW), null, 'unsigned');
  assert.equal(readSession('', secret, NOW), null);
});

test('production refuses to start without its guards', () => {
  const base = { K_SERVICE: 'homology', GOOGLE_CLIENT_ID: CLIENT, SESSION_SECRET: 'x'.repeat(40), ADMIN_EMAILS: 'a@b.org' };
  assert.deepEqual(loadConfig(base).problems, []);
  assert.equal(loadConfig(base).cfg.store, 'firestore');
  assert.match(loadConfig({ ...base, ALLOW_DEV_LOGIN: '1' }).problems.join(), /ALLOW_DEV_LOGIN/);
  assert.match(loadConfig({ ...base, ADMIN_EMAILS: '' }).problems.join(), /ADMIN_EMAILS/);
  assert.match(loadConfig({ ...base, GOOGLE_CLIENT_ID: '' }).problems.join(), /GOOGLE_CLIENT_ID/);
  assert.match(loadConfig({ ...base, SESSION_SECRET: 'short' }).problems.join(), /SESSION_SECRET/);
  assert.match(loadConfig({ ...base, STORE: 'memory' }).problems.join(), /STORE/);
});
