// Settings come from environment variables. In production the service refuses
// to start unless everything that guards the review view is in place.

import { randomBytes } from 'node:crypto';

const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

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

    // Storage
    store: env.STORE || (production ? 'firestore' : 'memory'),
    firestoreDatabase: env.FIRESTORE_DATABASE || 'homology',
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
    if (!cfg.googleClientId) problems.push('GOOGLE_CLIENT_ID is required.');
    if (cfg.sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters.');
    if (cfg.adminEmails.length === 0) problems.push('ADMIN_EMAILS must list at least one reviewer.');
    if (cfg.store !== 'firestore') problems.push('STORE must be firestore in production.');
    if (cfg.allowedOrigins.some((o) => !o.startsWith('https://'))) problems.push('ALLOWED_ORIGINS must be https.');
  } else if (!cfg.sessionSecret) {
    cfg.sessionSecret = randomBytes(32).toString('hex');
  }

  return { cfg, problems };
}
