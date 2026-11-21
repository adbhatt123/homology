// Settings come from environment variables. In production the service refuses
// to start unless everything that guards the review view is in place.

import { randomBytes } from 'node:crypto';

const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

// Reviewing in Slack is all or nothing: these are set together or not at all.
const SLACK_SETTINGS = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_REVIEW_CHANNEL', 'SLACK_REVIEWERS', 'SERVICE_URL'];

// "U012ABCDEF=first.reviewer@example.org,U045GHIJKL=second.reviewer@example.org"
function parseReviewers(value) {
  const reviewers = {};
  const bad = [];
  for (const pair of list(value)) {
    const [id, email, ...rest] = pair.split('=').map((s) => s.trim());
    if (rest.length || !/^[UW][A-Z0-9]{2,20}$/.test(id || '') || !email) bad.push(pair);
    else reviewers[id] = email.toLowerCase();
  }
  return { reviewers, bad };
}

export function loadConfig(env = process.env) {
  const production = Boolean(env.K_SERVICE) || env.NODE_ENV === 'production';

  const cfg = {
    production,
    port: Number(env.PORT || 8080),

    // Review access
    adminEmails: list(env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    sessionSecret: env.SESSION_SECRET || '',
    devLogin: env.ALLOW_DEV_LOGIN === '1',

    // The public site that is allowed to post applications
    allowedOrigins: list(env.ALLOWED_ORIGINS || 'https://homology.bio'),
    siteUrl: env.SITE_URL || 'https://homology.bio/',

    // Slack: existing members sign in here. This is never an invitation link.
    slackWorkspaceUrl: (env.SLACK_WORKSPACE_URL || 'https://homologybio.slack.com').replace(/\/+$/, ''),

    // This service's own public address, used for links back to the review view.
    serviceUrl: String(env.SERVICE_URL || '').replace(/\/+$/, ''),

    // Optional: post applications to the reviewers' private Slack channel and
    // let reviewers decide there. See src/slack.js.
    slack: {
      enabled: SLACK_SETTINGS.every((key) => env[key]),
      botToken: env.SLACK_BOT_TOKEN || '',
      signingSecret: env.SLACK_SIGNING_SECRET || '',
      channel: String(env.SLACK_REVIEW_CHANNEL || '').trim(),
      reviewers: parseReviewers(env.SLACK_REVIEWERS).reviewers,
      teamId: String(env.SLACK_TEAM_ID || 'T0CJTMG3DT8').trim(),
    },

    // Storage
    store: env.STORE || (production ? 'firestore' : 'memory'),
    firestoreDatabase: env.FIRESTORE_DATABASE || '(default)',
    firestoreCollection: env.FIRESTORE_COLLECTION || 'applications',
    projectId: env.GOOGLE_CLOUD_PROJECT || '',
    dataFile: env.DATA_FILE || '',

    // Abuse limits for the public endpoint
    applyPerIp: Number(env.APPLY_PER_IP || 8),
    applyWindowMs: Number(env.APPLY_WINDOW_MS || 10 * 60_000),
    applyGlobalPerHour: Number(env.APPLY_GLOBAL_PER_HOUR || 300),
  };

  const problems = [];
  if (production) {
    if (cfg.devLogin) problems.push('ALLOW_DEV_LOGIN must not be set in production.');
    if (cfg.sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters.');
    if (cfg.adminEmails.length === 0) problems.push('ADMIN_EMAILS must list at least one reviewer.');
    if (cfg.store !== 'firestore') problems.push('STORE must be firestore in production.');
    if (cfg.allowedOrigins.some((o) => !o.startsWith('https://'))) problems.push('ALLOWED_ORIGINS must be https.');
  } else if (!cfg.sessionSecret) {
    cfg.sessionSecret = randomBytes(32).toString('hex');
  }

  // A half-configured Slack setup is refused everywhere, not only in production.
  const slackSet = SLACK_SETTINGS.filter((key) => env[key]);
  if (slackSet.length && !cfg.slack.enabled) {
    const missing = SLACK_SETTINGS.filter((key) => !env[key]);
    problems.push(`Slack review needs all of ${SLACK_SETTINGS.join(', ')}. Missing: ${missing.join(', ')}.`);
  }
  if (cfg.slack.enabled) {
    const { bad } = parseReviewers(env.SLACK_REVIEWERS);
    const emails = Object.values(cfg.slack.reviewers);
    if (bad.length || emails.length === 0) {
      problems.push('SLACK_REVIEWERS must look like U012ABCDEF=reviewer@example.org, separated by commas.');
    }
    const strangers = emails.filter((email) => !cfg.adminEmails.includes(email));
    if (strangers.length) problems.push(`Every Slack reviewer must also be in ADMIN_EMAILS. Not there: ${strangers.join(', ')}.`);
    if (!/^[CG][A-Z0-9]{2,20}$/.test(cfg.slack.channel)) problems.push('SLACK_REVIEW_CHANNEL must be a channel ID, for example C0123456789.');
    if (!/^T[A-Z0-9]{2,20}$/.test(cfg.slack.teamId)) problems.push('SLACK_TEAM_ID must be a workspace ID, for example T0123456789.');
    const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cfg.serviceUrl);
    if (!cfg.serviceUrl.startsWith('https://') && !(local && !production)) problems.push('SERVICE_URL must be this service\'s https address.');
  }

  return { cfg, problems };
}
