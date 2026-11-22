import { createServer } from 'node:http';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/store.js';
import { signSession } from '../src/auth.js';

export const ADMIN = 'reviewer@example.org';
export const SECOND_ADMIN = 'second.reviewer@example.org';
export const OUTSIDER = 'someone.else@example.org';
export const SITE = 'https://homology.bio';

export const valid = (over = {}) => ({
  fullName: 'Test Applicant',
  email: 'Test.Applicant@example.org',
  city: 'New York',
  linkedinUrl: 'linkedin.com/in/test-applicant',
  roleAndOrg: 'Independent researcher',
  workingOn: 'Mapping how a cell type responds to a drug.\nSecond line.',
  introWish: 'A clinician who runs early trials in oncology.',
  canHelpWith: 'Single-cell data pipelines.',
  ...over,
});

// Starts the real server on a free port with an in-memory store and a clock the test controls.
export async function boot(envOver = {}, { identities = {}, slackFetch, mailFetch } = {}) {
  const { cfg, problems } = loadConfig({
    ADMIN_EMAILS: `${ADMIN}, ${SECOND_ADMIN}`,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-0123',
    ALLOWED_ORIGINS: SITE,
    ...envOver,
  });
  if (problems.length) throw new Error(problems.join(' '));
  const store = new MemoryStore();
  const intros = new MemoryStore();
  const clock = { t: Date.parse('2026-11-19T15:00:00.000Z') };
  const now = () => new Date(clock.t);
  const logs = [];
  const log = { info: (l) => logs.push(l), error: (l) => logs.push(l) };
  // Stands in for Google: a token is accepted only if the test registered it.
  const verifyIdToken = async (token) => {
    if (!identities[token]) {
      const { AuthError } = await import('../src/auth.js');
      throw new AuthError('bad_signature');
    }
    return identities[token];
  };
  // Tests never reach the real Slack: without a stand-in, any Slack call fails the test.
  const noSlack = async () => {
    throw new Error('unexpected call to Slack');
  };
  // The same goes for the mail service: no test sends a real email.
  const noMail = async () => {
    throw new Error('unexpected call to the mail service');
  };
  const handler = await createApp({ cfg, store, introStore: intros, now, verifyIdToken, log, slackFetch: slackFetch || noSlack, mailFetch: mailFetch || noMail });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // A test that fails before it closes its server must not keep the whole run waiting.
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}`;

  const cookieFor = (email, ms = 3600_000) =>
    `homology_review=${signSession(email, clock.t + ms, cfg.sessionSecret)}`;

  const call = (method, path, { body, cookie, headers = {}, review = true, raw } = {}) =>
    fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(review ? { 'X-Homology-Review': '1' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });

  const apply = (data, headers = {}) =>
    fetch(base + '/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE, ...headers },
      body: JSON.stringify(data),
    });

  return { cfg, store, intros, clock, logs, base, call, apply, cookieFor, close: () => new Promise((r) => server.close(r)) };
}
