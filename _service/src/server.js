// Homology application service.
//
// Public:   POST /api/apply            store one application as "pending"
// Private:  /review and /api/...       sign-in required, allowlisted admins only
//
// Optional: POST /api/slack/interactions   reviewers' button presses in Slack
//
// Applying cannot grant access to anything, and an invitation is only ever
// recorded by a reviewer after approval. When Slack review is switched on, the
// only Slack calls post each application to the reviewers' private channel and
// keep that message up to date (src/slack.js). Nothing here can send a Slack
// invitation.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConfig } from './config.js';
import { validateApplication, clean } from './validate.js';
import { DomainError, newApplication, recordInvitation, setNotes, setStatus, STATUS_LABELS } from './applications.js';
import { MemoryStore, FirestoreStore } from './store.js';
import {
  AuthError,
  SESSION_HOURS,
  createIdTokenVerifier,
  googleKeySource,
  readSession,
  sessionCookie,
  signSession,
} from './auth.js';
import { createSlackReview } from './slack.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');
const BODY_LIMIT = 32 * 1024;
// Slack sends the whole message back with each button press.
const SLACK_BODY_LIMIT = 512 * 1024;
// How long an applicant or reviewer waits for Slack before we answer them anyway.
const SLACK_WAIT_MS = 3500;

export const THANKS = 'Thanks for applying. We review every application and will email you with next steps.';

class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const REVIEW_CSP = [
  "default-src 'none'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self' https://accounts.google.com/gsi/",
  'frame-src https://accounts.google.com/gsi/',
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A small page for visitors whose browser has no JavaScript, so the form still works for them.
function plainPage({ title, lines, siteUrl }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#f5f3ec;color:#14302a;font:1.25rem/1.5 Georgia,serif}main{max-width:34rem;margin:0 auto;padding:18vh 1.5rem}p{margin:0 0 1em}a{color:inherit}</style></head><body><main>${lines
    .map((l) => `<p>${escapeHtml(l)}</p>`)
    .join('')}<p><a href="${escapeHtml(siteUrl)}">Back to Homology</a></p></main></body></html>`;
}

function createLimiter({ perIp, windowMs, globalPerHour, now }) {
  const hits = new Map();
  let global = [];
  return function allow(ip) {
    const t = now().getTime();
    global = global.filter((x) => t - x < 3600_000);
    if (global.length >= globalPerHour) return false;
    const mine = (hits.get(ip) || []).filter((x) => t - x < windowMs);
    if (mine.length >= perIp) {
      hits.set(ip, mine);
      return false;
    }
    mine.push(t);
    hits.set(ip, mine);
    global.push(t);
    if (hits.size > 5000) {
      for (const [key, list] of hits) if (!list.some((x) => t - x < windowMs)) hits.delete(key);
    }
    return true;
  };
}

async function readRaw(req, limit = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const readBody = async (req) => (await readRaw(req)).toString('utf8');

const atMost = (ms, promise) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms).unref())]);

async function readJson(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'json_required');
  try {
    const data = JSON.parse(await readBody(req));
    if (!data || typeof data !== 'object') throw new Error('not an object');
    return data;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'invalid_json');
  }
}

export async function createApp({ cfg, store, now = () => new Date(), verifyIdToken, log = console, slackFetch = fetch }) {
  const assets = {
    '/review': { type: 'text/html; charset=utf-8', body: await readFile(join(PUBLIC_DIR, 'review.html')) },
    '/review.css': { type: 'text/css; charset=utf-8', body: await readFile(join(PUBLIC_DIR, 'review.css')) },
    '/review.js': { type: 'text/javascript; charset=utf-8', body: await readFile(join(PUBLIC_DIR, 'review.js')) },
  };

  const allow = createLimiter({
    perIp: cfg.applyPerIp,
    windowMs: cfg.applyWindowMs,
    globalPerHour: cfg.applyGlobalPerHour,
    now,
  });

  const baseHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store',
    ...(cfg.production ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };

  const send = (res, status, body, headers = {}) => {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      ...baseHeaders,
      ...(typeof body === 'object' && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      ...headers,
    });
    res.end(payload);
  };

  const event = (name, fields = {}) => log.info(JSON.stringify({ event: name, at: now().toISOString(), ...fields }));

  const slack = cfg.slack.enabled ? createSlackReview({ cfg, store, now, event, fetchImpl: slackFetch }) : null;

  const clientIp = (req) => {
    // Cloud Run appends the real client address as the last entry.
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return forwarded.at(-1) || req.socket.remoteAddress || 'unknown';
  };

  // ---------- public: apply ----------

  const corsHeaders = (req) => {
    const origin = req.headers.origin;
    if (!origin) return {};
    if (!cfg.allowedOrigins.includes(origin)) throw new HttpError(403, 'origin_not_allowed');
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  };

  async function apply(req, res) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return send(res, 204, '', cors);

    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const isForm = type === 'application/x-www-form-urlencoded';
    if (!isForm && type !== 'application/json') throw new HttpError(415, 'unsupported_type', { cors });

    const raw = await readBody(req);
    let data;
    try {
      data = isForm ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'invalid_body', { cors });
    }

    const respond = (status, json, page) =>
      isForm
        ? send(res, status, plainPage({ ...page, siteUrl: cfg.siteUrl }), { ...cors, 'Content-Type': 'text/html; charset=utf-8' })
        : send(res, status, json, cors);

    if (!allow(clientIp(req))) {
      event('application.rate_limited');
      return respond(
        429,
        { ok: false, error: 'rate_limited' },
        { title: 'Please try again later', lines: ['We have received several applications from this connection in a short time. Please try again later.'] },
      );
    }

    // A field people never see. Anything that fills it in is not a person:
    // answer as if it worked and keep nothing.
    if (clean(data?.company_website)) {
      event('application.discarded');
      return respond(200, { ok: true, message: THANKS }, { title: 'Application received', lines: [THANKS] });
    }

    const result = validateApplication(data);
    if (!result.ok) {
      return respond(
        422,
        { ok: false, error: 'invalid', errors: result.errors },
        {
          title: 'Application not sent',
          lines: ['Your application was not sent. Please go back and check these fields:', ...Object.values(result.errors)],
        },
      );
    }

    const application = newApplication(result.values, now().toISOString(), randomUUID());
    await store.create(application);
    event('application.submitted', { id: application.id });
    // Tell the reviewers. The application is already saved, so nothing that
    // happens in Slack can lose it or change what the applicant is told.
    if (slack) await atMost(SLACK_WAIT_MS, slack.sync(application));
    return respond(200, { ok: true, message: THANKS }, { title: 'Application received', lines: [THANKS] });
  }

  // ---------- private: review ----------

  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  // Every change must come from the review page itself: same origin, plus a
  // header that another site's form or script cannot attach.
  const guardWrite = (req) => {
    if (!sameOrigin(req) || req.headers['x-homology-review'] !== '1') throw new HttpError(403, 'forbidden');
  };

  const requireAdmin = (req) => {
    const email = readSession(req.headers.cookie, cfg.sessionSecret, now().getTime());
    if (!email) throw new HttpError(401, 'sign_in_required');
    if (!cfg.adminEmails.includes(email)) throw new HttpError(403, 'not_authorized');
    return email;
  };

  const startSession = (res, email) => {
    const maxAgeS = SESSION_HOURS * 3600;
    const value = signSession(email, now().getTime() + maxAgeS * 1000, cfg.sessionSecret);
    send(res, 200, { email }, { 'Set-Cookie': sessionCookie(value, { secure: cfg.production, maxAgeS }) });
  };

  async function signIn(req, res) {
    guardWrite(req);
    const { credential } = await readJson(req);
    let identity;
    try {
      identity = await verifyIdToken(credential);
    } catch (err) {
      if (err instanceof AuthError) throw new HttpError(401, 'sign_in_failed');
      throw err;
    }
    if (!cfg.adminEmails.includes(identity.email)) {
      event('review.sign_in_refused');
      throw new HttpError(403, 'not_authorized');
    }
    event('review.sign_in', { by: identity.email });
    startSession(res, identity.email);
  }

  async function devSignIn(req, res) {
    if (!cfg.devLogin || cfg.production) throw new HttpError(404, 'not_found');
    guardWrite(req);
    const { email } = await readJson(req);
    const address = String(email || '').trim().toLowerCase();
    if (!cfg.adminEmails.includes(address)) throw new HttpError(403, 'not_authorized');
    startSession(res, address);
  }

  async function listApplications(req, res) {
    requireAdmin(req);
    const all = (await store.list()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const perEmail = new Map();
    for (const a of all) perEmail.set(a.emailKey, (perEmail.get(a.emailKey) || 0) + 1);
    send(res, 200, {
      applications: all.map((a) => ({ ...a, otherApplications: perEmail.get(a.emailKey) - 1 })),
      statusLabels: STATUS_LABELS,
    });
  }

  async function change(req, res, id, apply) {
    const admin = requireAdmin(req);
    guardWrite(req);
    const body = await readJson(req);
    const nowIso = now().toISOString();
    const updated = await store.update(id, (doc) => apply(doc, body, admin, nowIso));
    if (!updated) throw new HttpError(404, 'not_found');
    if (slack) await atMost(SLACK_WAIT_MS, slack.sync(updated));
    send(res, 200, { application: updated });
  }

  // ---------- reviewers' button presses in Slack ----------

  async function slackInteraction(req, res) {
    if (!slack) throw new HttpError(404, 'not_found');
    const raw = await readRaw(req, SLACK_BODY_LIMIT);
    if (!slack.verify(req.headers, raw)) {
      event('slack.bad_signature');
      throw new HttpError(401, 'bad_signature');
    }
    let payload;
    try {
      payload = JSON.parse(new URLSearchParams(raw.toString('utf8')).get('payload'));
    } catch {
      throw new HttpError(400, 'invalid_body');
    }
    const out = await slack.interaction(payload);
    send(res, out.status, out.body);
  }

  const routes = [
    ['POST', /^\/api\/slack\/interactions$/, (req, res) => slackInteraction(req, res)],
    ['POST', /^\/api\/session$/, (req, res) => signIn(req, res)],
    ['POST', /^\/api\/dev-session$/, (req, res) => devSignIn(req, res)],
    ['GET', /^\/api\/session$/, (req, res) => send(res, 200, { email: requireAdmin(req) })],
    ['DELETE', /^\/api\/session$/, (req, res) => {
      guardWrite(req);
      send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', { secure: cfg.production, maxAgeS: 0 }) });
    }],
    ['GET', /^\/api\/applications$/, (req, res) => listApplications(req, res)],
    ['POST', /^\/api\/applications\/([0-9a-f-]{36})\/status$/, (req, res, [id]) =>
      change(req, res, id, (doc, body, admin, t) => {
        const before = doc.status;
        const next = setStatus(doc, body.status, admin, t);
        if (next.status !== before) event('application.status', { id, by: admin, from: before, to: next.status });
        return next;
      })],
    ['POST', /^\/api\/applications\/([0-9a-f-]{36})\/notes$/, (req, res, [id]) =>
      change(req, res, id, (doc, body, admin, t) => setNotes(doc, body.text, admin, t))],
    ['POST', /^\/api\/applications\/([0-9a-f-]{36})\/invitation$/, (req, res, [id]) =>
      change(req, res, id, (doc, body, admin, t) => {
        const before = doc.invitation.status;
        const next = recordInvitation(doc, body.action, admin, t, 'manual');
        if (next.invitation.status !== before) {
          event('application.invitation', { id, by: admin, from: before, to: next.invitation.status });
        }
        return next;
      })],
  ];

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    try {
      if (path === '/health') return send(res, 200, { ok: true });

      if (path === '/api/apply') {
        if (req.method !== 'POST' && req.method !== 'OPTIONS') throw new HttpError(405, 'method_not_allowed');
        return await apply(req, res);
      }

      if (req.method === 'GET' && path === '/') return send(res, 302, '', { Location: '/review' });

      if (req.method === 'GET' && assets[path]) {
        return send(res, 200, assets[path].body, {
          'Content-Type': assets[path].type,
          'Content-Security-Policy': REVIEW_CSP,
          'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
        });
      }

      // Safe to show before sign-in: it only says how to sign in and where Slack is.
      if (req.method === 'GET' && path === '/api/config') {
        return send(res, 200, {
          googleClientId: cfg.googleClientId,
          devLogin: cfg.devLogin && !cfg.production,
          slack: {
            workspaceUrl: cfg.slackWorkspaceUrl,
            invitePeopleUrl: `${cfg.slackWorkspaceUrl}/admin/invites`,
            integration: 'manual',
          },
        });
      }

      for (const [method, pattern, run] of routes) {
        const match = pattern.exec(path);
        if (match && req.method === method) return await run(req, res, match.slice(1));
      }
      throw new HttpError(404, 'not_found');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { ok: false, error: err.code }, err.extra.cors || {});
      if (err instanceof DomainError) return send(res, err.status, { ok: false, error: err.code, message: err.message });
      log.error(JSON.stringify({ event: 'error', at: now().toISOString(), path, message: String(err && err.message) }));
      return send(res, 500, { ok: false, error: 'server_error' });
    }
  };
}

export async function main(env = process.env) {
  const { cfg, problems } = loadConfig(env);
  if (problems.length) {
    console.error('Refusing to start:\n- ' + problems.join('\n- '));
    process.exit(1);
  }
  const store =
    cfg.store === 'firestore'
      ? await FirestoreStore.connect({
          database: cfg.firestoreDatabase,
          collection: cfg.firestoreCollection,
          projectId: cfg.projectId,
        })
      : new MemoryStore({ file: cfg.dataFile });
  const verifyIdToken = createIdTokenVerifier({ clientId: cfg.googleClientId, getKeys: googleKeySource() });
  const handler = await createApp({ cfg, store, verifyIdToken });
  createServer(handler).listen(cfg.port, () => {
    console.info(JSON.stringify({ event: 'listening', port: cfg.port, store: cfg.store, production: cfg.production }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
