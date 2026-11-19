// Who may open the review view.
//
// Admins sign in with Google. The server checks Google's signature on the
// sign-in token itself, then checks the verified email against ADMIN_EMAILS.
// The allowlist is checked again on every request, so removing an address
// takes effect at once, even for someone already signed in.

import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';

const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_SKEW_S = 120;

export const SESSION_COOKIE = 'homology_review';
export const SESSION_HOURS = 8;

const b64uToBuffer = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export class AuthError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Fetches Google's public signing keys and remembers them for an hour.
export function googleKeySource(fetchImpl = fetch) {
  let cache = { keys: [], at: 0 };
  return async function getKeys({ refresh = false } = {}) {
    if (!refresh && cache.keys.length && Date.now() - cache.at < 3600_000) return cache.keys;
    const res = await fetchImpl(GOOGLE_CERTS);
    if (!res.ok) throw new AuthError('keys_unavailable');
    const body = await res.json();
    cache = { keys: body.keys || [], at: Date.now() };
    return cache.keys;
  };
}

export function createIdTokenVerifier({ clientId, getKeys, now = () => Date.now() }) {
  return async function verifyIdToken(token) {
    if (typeof token !== 'string' || token.split('.').length !== 3) throw new AuthError('malformed_token');
    const [h, p, s] = token.split('.');
    let header;
    let claims;
    try {
      header = JSON.parse(b64uToBuffer(h).toString('utf8'));
      claims = JSON.parse(b64uToBuffer(p).toString('utf8'));
    } catch {
      throw new AuthError('malformed_token');
    }
    if (header.alg !== 'RS256' || !header.kid) throw new AuthError('unsupported_token');

    let jwk = (await getKeys()).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await getKeys({ refresh: true })).find((k) => k.kid === header.kid);
    if (!jwk) throw new AuthError('unknown_key');

    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const signed = verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`), key, b64uToBuffer(s));
    if (!signed) throw new AuthError('bad_signature');

    const nowS = Math.floor(now() / 1000);
    if (!GOOGLE_ISSUERS.has(claims.iss)) throw new AuthError('wrong_issuer');
    if (!clientId || claims.aud !== clientId) throw new AuthError('wrong_audience');
    if (typeof claims.exp !== 'number' || claims.exp < nowS - CLOCK_SKEW_S) throw new AuthError('expired');
    if (typeof claims.iat === 'number' && claims.iat > nowS + CLOCK_SKEW_S) throw new AuthError('not_yet_valid');
    if (!claims.email || claims.email_verified !== true) throw new AuthError('email_not_verified');

    return { email: String(claims.email).toLowerCase(), name: claims.name || '' };
  };
}

const mac = (secret, payload) => createHmac('sha256', secret).update(payload).digest();

export function signSession(email, expiresAtMs, secret) {
  const payload = b64u(JSON.stringify({ e: email, x: expiresAtMs }));
  return `${payload}.${b64u(mac(secret, payload))}`;
}

export function readSession(cookieHeader, secret, nowMs) {
  const match = /(?:^|;\s*)homology_review=([^;]+)/.exec(cookieHeader || '');
  if (!match) return null;
  const [payload, sig] = match[1].split('.');
  if (!payload || !sig) return null;
  const expected = mac(secret, payload);
  const given = b64uToBuffer(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { e, x } = JSON.parse(b64uToBuffer(payload).toString('utf8'));
    if (typeof e !== 'string' || typeof x !== 'number' || x < nowMs) return null;
    return e;
  } catch {
    return null;
  }
}

export function sessionCookie(value, { secure, maxAgeS }) {
  const parts = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeS}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
