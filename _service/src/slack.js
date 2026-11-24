// Slack review: each new application is posted to the reviewers' private
// channel, and reviewers can decide there.
//
// What this file can do in Slack: post and edit its own messages in the one
// configured channel, open one dialog for notes, and read that channel's
// privacy setting and member list. It has no way to invite anyone to the
// workspace, so the invitation stays a manual step that a reviewer records.
//
// A reviewer can also move an application to an intro call from here, and
// record the welcome or decline email that follows a decision. Those are
// emails the reviewer sends from their own inbox: a button only opens the
// draft. A record made by mistake is cleared in the review view.
//
// Three checks stand between a button press and a change:
//   1. Slack's signature on the request, so it really came from Slack
//   2. the workspace and the channel it came from
//   3. the person who pressed it, matched to a reviewer who is in ADMIN_EMAILS
//
// What applicants wrote is only ever sent as literal text, never as Slack
// markup, so an answer cannot ping people or disguise a link.

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  DomainError,
  STATUS_LABELS,
  callOf,
  emailsOf,
  receiptOf,
  recordCallInvite,
  recordDecisionEmail,
  recordInvitation,
  setNotes,
  setStatus,
  spamCheckOf,
} from './applications.js';
import { draftUrls } from './emails.js';
import { normalizeLinkedin } from './validate.js';

const API = 'https://slack.com/api';
const RESPONSE_URLS = 'https://hooks.slack.com/';
const SIGNATURE_MAX_AGE_S = 300;
const CALL_TIMEOUT_MS = 2500;
const NOTE_LIMIT_IN_SLACK = 3000;
const BUTTON_URL_LIMIT = 3000;
const APPLICATION_ID = /^[0-9a-f-]{36}$/;
const MEMBER_ID = /^[UW][A-Z0-9]{2,20}$/;

export class SlackError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Slack signs every request with a secret only Slack and this service hold.
export function verifySlackSignature({ signingSecret, timestamp, signature, rawBody, nowMs }) {
  if (!signingSecret || !/^\d{1,12}$/.test(String(timestamp ?? ''))) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_MAX_AGE_S) return false;
  const mac = createHmac('sha256', signingSecret).update(`v0:${timestamp}:`).update(rawBody).digest('hex');
  const expected = Buffer.from(`v0=${mac}`);
  const given = Buffer.from(String(signature ?? ''));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---------- what a message looks like ----------

const QUESTIONS = [
  ['What are you working on?', 'workingOn'],
  ['Who would you most like us to introduce you to?', 'introWish'],
  ['What could you help someone else with?', 'canHelpWith'],
];

// Applicant text. Slack shows it exactly as written: no formatting, no mentions, no emoji codes.
const plain = (text, max) => {
  const s = String(text ?? '');
  return { type: 'plain_text', text: s.length > max ? `${s.slice(0, max - 1)}…` : s || ' ', emoji: false };
};

// Longer text, such as an answer or a note. Slack keeps its line breaks and,
// as with plain(), shows every character as typed: nothing in it is read as
// formatting, a mention or a link.
const literal = (text) => ({
  type: 'rich_text',
  elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: String(text ?? '') || ' ' }] }],
});

// Text this service wrote itself. Never pass applicant text here.
const markup = (text) => ({ type: 'mrkdwn', text });
const escapeMarkup = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const label = (text) => ({ type: 'plain_text', text, emoji: false });

// Shown in each reader's own time zone.
const when = (iso) => {
  const seconds = Math.floor(Date.parse(iso) / 1000);
  return Number.isFinite(seconds) ? `<!date^${seconds}^{date_short_pretty} at {time}|${escapeMarkup(iso)}>` : 'an unknown time';
};

const button = (text, actionId, value, style) => ({
  type: 'button',
  text: label(text),
  action_id: actionId,
  value,
  ...(style ? { style } : {}),
});
const linkButton = (text, actionId, url) => ({ type: 'button', text: label(text), action_id: actionId, url });

function decisionLine(app) {
  const name = STATUS_LABELS[app.status];
  if (!app.review) return `*${name}*`;
  const who = `${escapeMarkup(app.review.by)}, ${when(app.review.at)}`;
  if (app.status === 'pending') return `*${name}* (moved back by ${who})`;
  if (app.status === 'call') return `*${name}* (moved to a call by ${who})`;
  return `*${name}* by ${who}`;
}

function callLine(app) {
  const call = callOf(app);
  if (!call.inviteSentAt) {
    return `*Call invite:* ${NOT_SENT}`;
  }
  const sent = `*Call invite:* sent, recorded by ${escapeMarkup(call.inviteSentBy)}, ${when(call.inviteSentAt)}.`;
  return app.status === 'call' ? `${sent} After the call, add what you learned as a note, then approve or decline.` : sent;
}

const NOT_SENT = 'not sent. Write it from the button below, send it from your own inbox, then record it here.';

function emailLine(app, kind) {
  const name = kind === 'welcome' ? 'Welcome email' : 'Decline email';
  const email = emailsOf(app)[kind];
  return email.sentAt
    ? `*${name}:* sent, recorded by ${escapeMarkup(email.sentBy)}, ${when(email.sentAt)}.`
    : `*${name}:* ${NOT_SENT}`;
}

function invitationLine(app) {
  const inv = app.invitation;
  if (inv.status === 'sent') {
    return `*Slack invitation:* sent, recorded by ${escapeMarkup(inv.sentBy)}, ${when(inv.sentAt)}. The decision is locked while this is on record.`;
  }
  if (inv.status === 'joined') {
    return `*Slack invitation:* joined, recorded by ${escapeMarkup(inv.joinedRecordedBy)}, ${when(inv.joinedAt)}. The decision is locked while this is on record.`;
  }
  return '*Slack invitation:* not sent. Approving adds nobody to Slack. Open Slack invitations, invite the email address above as a member, then record it here. Never use a shared invite link.';
}

// Shown on an application that filled in the form's hidden field.
export const SPAM_CHECK_LINE =
  "*Check this one before you trust it.* It filled in a field on the form that people can't see. That is usually a bot, but a browser's autofill can do it for a real person too. It was kept so you can decide. No receipt email was sent.";

// `drafts` holds the Gmail draft links: { call, welcome, decline }.
export function applicationMessage(app, { reviewUrl, invitesUrl, drafts = {} }) {
  const a = app.answers;
  const inv = app.invitation;
  const call = callOf(app);
  const emails = emailsOf(app);
  const locked = inv.status !== 'not_sent';

  const blocks = [
    { type: 'header', text: plain(a.fullName, 150) },
    ...(spamCheckOf(app).tripped ? [{ type: 'section', text: markup(SPAM_CHECK_LINE) }] : []),
    {
      type: 'section',
      fields: [
        markup('*Role*'), plain(a.roleAndOrg, 2000),
        markup('*City*'), plain(a.city, 2000),
        markup('*Email*'), plain(a.email, 2000),
        markup('*LinkedIn*'), plain(a.linkedinUrl, 2000),
      ],
    },
    ...QUESTIONS.flatMap(([question, key]) => [
      { type: 'context', elements: [markup(`*${question}*`)] },
      literal(a[key]),
    ]),
    { type: 'context', elements: [markup(`Applied ${when(app.createdAt)}${receiptOf(app).sentAt ? '. Receipt emailed to them.' : ''}`)] },
    { type: 'divider' },
    { type: 'section', text: markup(decisionLine(app)) },
  ];

  // An email that went out stays on the message even if the decision later changes.
  if (app.status === 'call' || call.inviteSentAt) blocks.push({ type: 'section', text: markup(callLine(app)) });
  if (app.status === 'declined' || emails.decline.sentAt) blocks.push({ type: 'section', text: markup(emailLine(app, 'decline')) });
  if (app.status === 'approved' || emails.welcome.sentAt) blocks.push({ type: 'section', text: markup(emailLine(app, 'welcome')) });
  if (app.status === 'approved' || locked) blocks.push({ type: 'section', text: markup(invitationLine(app)) });

  if (app.notes.text) {
    const tooLong = app.notes.text.length > NOTE_LIMIT_IN_SLACK - 100;
    blocks.push(
      {
        type: 'context',
        elements: [markup(`*Private notes*, last edited by ${escapeMarkup(app.notes.updatedBy)}, ${when(app.notes.updatedAt)}`)],
      },
      literal(tooLong ? `${app.notes.text.slice(0, NOTE_LIMIT_IN_SLACK - 100)}…\n(The rest is in the review view.)` : app.notes.text),
    );
  }

  // Three rows of buttons, each shown only when it has something to offer:
  //   step     the email that belongs to this stage, until it is recorded
  //   invite   the manual Slack invitation, once approved
  //   decide   the decision itself
  // One button stands out at a time: the next thing to do.
  const step = [];
  const emailStep = (write, draft, linkId, record, actionId) => {
    if (drafts[draft]) step.push(linkButton(write, linkId, drafts[draft]));
    step.push(button(record, actionId, app.id, 'primary'));
  };
  const atCall = app.status === 'call';
  if (atCall && !call.inviteSentAt) emailStep('Write call invite', 'call', 'link_call_invite', 'Record call invite sent', 'call_sent');
  if (app.status === 'approved' && !emails.welcome.sentAt) {
    emailStep('Write welcome email', 'welcome', 'link_welcome_email', 'Record welcome email sent', 'email_welcome_sent');
  }
  if (app.status === 'declined' && !emails.decline.sentAt) {
    emailStep('Write decline email', 'decline', 'link_decline_email', 'Record decline email sent', 'email_decline_sent');
  }
  const next = step.length ? undefined : 'primary';

  const invite = [];
  if (inv.status === 'sent') {
    invite.push(button('Mark as joined', 'inv_joined', app.id, next), button('Clear invitation record', 'inv_clear', app.id));
  } else if (inv.status === 'joined') {
    invite.push(button('Clear invitation record', 'inv_clear', app.id));
  } else if (app.status === 'approved') {
    invite.push(
      linkButton('Open Slack invitations', 'link_invites', invitesUrl),
      button('Record invitation sent', 'inv_sent', app.id, next),
    );
  }

  const decide = [];
  if (!locked) {
    if (app.status === 'pending') decide.push(button('Move to call', 'status_call', app.id, 'primary'));
    if (app.status !== 'approved') {
      decide.push(
        button(
          app.status === 'pending' ? 'Approve without a call' : 'Approve',
          'status_approved',
          app.id,
          atCall && call.inviteSentAt ? 'primary' : undefined,
        ),
      );
    }
    if (app.status !== 'declined') decide.push(button('Decline', 'status_declined', app.id));
    if (app.status !== 'pending') decide.push(button('Move back to pending', 'status_pending', app.id));
    if (atCall && call.inviteSentAt) decide.push(button('Clear call invite record', 'call_clear', app.id));
  }

  const more = [button(app.notes.text ? 'Edit note' : 'Add note', 'notes_edit', app.id)];
  const profile = normalizeLinkedin(a.linkedinUrl);
  if (profile) more.push(linkButton('LinkedIn profile', 'link_profile', profile));
  more.push(linkButton('Open in review view', 'link_review', reviewUrl));

  for (const [id, elements] of [['step', step], ['invite', invite], ['decide', decide], ['more', more]]) {
    if (elements.length) blocks.push({ type: 'actions', block_id: id, elements });
  }

  // The line phones show in a notification. It names nobody.
  const fresh = app.status === 'pending' && !app.review;
  const text = fresh
    ? `New Homology application${spamCheckOf(app).tripped ? ' (check for spam)' : ''}`
    : `Homology application: ${STATUS_LABELS[app.status].toLowerCase()}`;
  return { text, blocks };
}

const NOTICE_REASONS = {
  not_private: 'this channel is not private',
  shared: 'this channel is shared with another organization',
  outsiders: 'this channel includes people or apps that are not reviewers',
  unchecked: 'this channel could not be checked',
};

// Posted in place of the application when the channel is not safe for answers.
export function noticeMessage({ reviewUrl, reason }) {
  return {
    text: 'New Homology application',
    blocks: [
      {
        type: 'section',
        text: markup(`*A new application arrived.* It is not shown here because ${NOTICE_REASONS[reason] || NOTICE_REASONS.unchecked}. Read it in the review view.`),
      },
      { type: 'actions', block_id: 'more', elements: [linkButton('Open in review view', 'link_review', reviewUrl)] },
    ],
  };
}

export function notesDialog(app) {
  return {
    type: 'modal',
    callback_id: 'notes_save',
    private_metadata: app.id,
    title: label('Private notes'),
    submit: label('Save'),
    close: label('Cancel'),
    blocks: [
      { type: 'section', text: plain(app.answers.fullName, 3000) },
      {
        type: 'input',
        block_id: 'notes',
        optional: true,
        label: label('Notes'),
        hint: label('Only reviewers see these. The applicant never does.'),
        element: {
          type: 'plain_text_input',
          action_id: 'text',
          multiline: true,
          max_length: NOTE_LIMIT_IN_SLACK,
          ...(app.notes.text ? { initial_value: app.notes.text } : {}),
        },
      },
    ],
  };
}

// ---------- talking to Slack ----------

export function createSlackReview({ cfg, store, now, event, fetchImpl = fetch }) {
  const { botToken, signingSecret, channel, reviewers, teamId } = cfg.slack;
  const links = { reviewUrl: `${cfg.serviceUrl}/review`, invitesUrl: `${cfg.slackWorkspaceUrl}/admin/invites` };
  let botUserId = null;

  // The emails as Gmail drafts. Slack caps how long a button's link can be,
  // so a draft that would not fit opens with the address and subject only.
  // The message is shared by every reviewer, so the links name no Google account.
  const draw = (app) =>
    applicationMessage(app, {
      ...links,
      drafts: draftUrls(app, { bookingUrl: cfg.callBookingUrl, maxLength: BUTTON_URL_LIMIT }),
    });

  async function api(method, args) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) body.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    let json;
    try {
      const res = await fetchImpl(`${API}/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: body.toString(),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      json = await res.json();
    } catch {
      throw new SlackError('unreachable');
    }
    if (!json || json.ok !== true) throw new SlackError(String((json && json.error) || 'failed').slice(0, 60));
    return json;
  }

  // The person behind a Slack account, if they are a reviewer right now.
  // ADMIN_EMAILS is checked every time, so removing someone there is enough.
  const reviewerFor = (userId) => {
    const email = Object.hasOwn(reviewers, userId) ? reviewers[userId] : null;
    return email && cfg.adminEmails.includes(email) ? email : null;
  };

  // Answers go only to a private channel whose every member is a reviewer.
  async function channelProblem() {
    try {
      const info = (await api('conversations.info', { channel })).channel || {};
      if (info.is_private !== true) return 'not_private';
      if (info.is_ext_shared || info.is_pending_ext_shared) return 'shared';
      botUserId ??= (await api('auth.test', {})).user_id;
      const page = await api('conversations.members', { channel, limit: 200 });
      if (page.response_metadata && page.response_metadata.next_cursor) return 'outsiders';
      const members = Array.isArray(page.members) ? page.members : [];
      return members.every((id) => id === botUserId || reviewerFor(id)) ? null : 'outsiders';
    } catch {
      return 'unchecked';
    }
  }

  async function post(app) {
    const reason = await channelProblem();
    const message = reason ? noticeMessage({ reviewUrl: links.reviewUrl, reason }) : draw(app);
    const sent = await api('chat.postMessage', {
      channel,
      text: message.text,
      blocks: message.blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
    await store.update(app.id, (doc) => ({ ...doc, slack: { channel, ts: String(sent.ts), full: !reason } }));
    event(reason ? 'slack.notice_posted' : 'slack.posted', { id: app.id, ...(reason ? { reason } : {}) });
  }

  async function redraw(app) {
    const at = app.slack;
    if (!at.full) {
      // Only a short notice was posted, because the channel was not safe for
      // answers. Replace it with the application once the channel is.
      if (await channelProblem()) return;
    }
    const message = draw(app);
    await api('chat.update', { channel, ts: at.ts, text: message.text, blocks: message.blocks });
    if (!at.full) {
      await store.update(app.id, (doc) => ({ ...doc, slack: { ...doc.slack, full: true } }));
      event('slack.posted', { id: app.id });
    }
  }

  // Posts the application, or brings its existing message up to date.
  // Never throws: Slack being down must not lose an application or block a reviewer.
  async function sync(app) {
    try {
      const at = app.slack;
      if (!at || at.channel !== channel) return await post(app);
      try {
        await redraw(app);
      } catch (err) {
        // Someone deleted the message in Slack. Post it again.
        if (!(err instanceof SlackError) || err.code !== 'message_not_found') throw err;
        await post(app);
      }
    } catch (err) {
      event('slack.failed', { id: app.id, error: err instanceof SlackError ? err.code : 'error' });
    }
    return undefined;
  }

  // A reply only the person who pressed the button can see.
  async function whisper(responseUrl, text) {
    if (typeof responseUrl !== 'string' || !responseUrl.startsWith(RESPONSE_URLS)) return;
    try {
      await fetchImpl(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      // The change itself has already been refused or applied. Nothing else to do.
    }
  }

  // Marks the history entries a change added, so the record shows it was made from Slack.
  const fromSlack = (doc, before) => {
    for (const entry of doc.history.slice(before)) entry.via = 'slack';
    return doc;
  };

  const decide = (status) => (doc, by, t) => {
    const before = doc.history.length;
    const from = doc.status;
    const next = setStatus(doc, status, by, t);
    if (next.status !== from) event('application.status', { id: doc.id, by, from, to: next.status, via: 'slack' });
    return fromSlack(next, before);
  };

  const invite = (action) => (doc, by, t) => {
    const before = doc.history.length;
    const from = doc.invitation.status;
    const next = recordInvitation(doc, action, by, t, 'manual');
    if (next.invitation.status !== from) {
      event('application.invitation', { id: doc.id, by, from, to: next.invitation.status, via: 'slack' });
    }
    return fromSlack(next, before);
  };

  const callInvite = (action) => (doc, by, t) => {
    const before = doc.history.length;
    const had = callOf(doc).inviteSentAt;
    const next = recordCallInvite(doc, action, by, t);
    const has = callOf(next).inviteSentAt;
    if (has !== had) event('application.call_invite', { id: doc.id, by, to: has ? 'sent' : 'not_sent', via: 'slack' });
    return fromSlack(next, before);
  };

  const decisionEmail = (kind) => (doc, by, t) => {
    const before = doc.history.length;
    const next = recordDecisionEmail(doc, kind, 'sent', by, t);
    event('application.email', { id: doc.id, by, kind, to: 'sent', via: 'slack' });
    return fromSlack(next, before);
  };

  const CHANGES = {
    status_call: decide('call'),
    call_sent: callInvite('sent'),
    call_clear: callInvite('clear'),
    email_welcome_sent: decisionEmail('welcome'),
    email_decline_sent: decisionEmail('decline'),
    status_approved: decide('approved'),
    status_declined: decide('declined'),
    status_pending: decide('pending'),
    inv_sent: invite('sent'),
    inv_joined: invite('joined'),
    inv_clear: invite('clear'),
  };

  const ok = { status: 200, body: '' };
  const refuse = (status, error) => ({ status, body: { ok: false, error } });

  async function pressed(payload, reviewer, nowIso) {
    if (!payload.container || payload.container.channel_id !== channel) return refuse(403, 'wrong_channel');
    const action = (Array.isArray(payload.actions) && payload.actions[0]) || {};
    const actionId = String(action.action_id || '');
    if (actionId.startsWith('link_')) return ok; // a link button: Slack only tells us it was opened

    if (!reviewer) {
      const who = MEMBER_ID.test(String(payload.user && payload.user.id)) ? payload.user.id : 'unknown';
      event('slack.refused', { user: who });
      await whisper(
        payload.response_url,
        `You are not set up to review Homology applications, so nothing was changed. If you should be, ask an admin to add your Slack member ID: ${who}`,
      );
      return ok;
    }

    const id = String(action.value || '');
    if (!APPLICATION_ID.test(id)) return refuse(400, 'unknown_application');

    if (actionId === 'notes_edit') {
      const app = await store.get(id);
      if (!app) {
        await whisper(payload.response_url, 'This application no longer exists.');
      } else if (app.notes.text.length > NOTE_LIMIT_IN_SLACK) {
        await whisper(payload.response_url, 'This note is too long to edit in Slack. Use "Open in review view" instead.');
      } else {
        try {
          await api('views.open', { trigger_id: String(payload.trigger_id || ''), view: notesDialog(app) });
        } catch (err) {
          event('slack.failed', { id, error: err instanceof SlackError ? err.code : 'error' });
          await whisper(payload.response_url, 'Slack could not open the notes box. Try again, or use the review view.');
        }
      }
      return ok;
    }

    const change = Object.hasOwn(CHANGES, actionId) ? CHANGES[actionId] : null;
    if (!change) return refuse(400, 'unknown_action');

    try {
      const updated = await store.update(id, (doc) => change(doc, reviewer, nowIso));
      if (updated) await sync(updated);
      else await whisper(payload.response_url, 'This application no longer exists.');
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      // The rules said no. Say why, and redraw the message in case it was out of date.
      await whisper(payload.response_url, err.message);
      const current = await store.get(id);
      if (current) await sync(current);
    }
    return ok;
  }

  async function notesSaved(payload, reviewer, nowIso) {
    const fail = (message) => ({ status: 200, body: { response_action: 'errors', errors: { notes: message } } });
    if (!reviewer) return fail('You are not set up to review Homology applications.');
    const id = String(payload.view.private_metadata || '');
    if (!APPLICATION_ID.test(id)) return fail('This application could not be found.');
    const values = (payload.view.state && payload.view.state.values) || {};
    const text = (values.notes && values.notes.text && values.notes.text.value) || '';
    let updated;
    try {
      updated = await store.update(id, (doc) => {
        const before = doc.history.length;
        return fromSlack(setNotes(doc, text, reviewer, nowIso), before);
      });
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      return fail(err.message);
    }
    if (!updated) return fail('This application no longer exists.');
    await sync(updated);
    return ok;
  }

  return {
    sync,

    verify: (headers, rawBody) =>
      verifySlackSignature({
        signingSecret,
        timestamp: headers['x-slack-request-timestamp'],
        signature: headers['x-slack-signature'],
        rawBody,
        nowMs: now().getTime(),
      }),

    // Call only after verify() has passed.
    async interaction(payload) {
      if (!payload || typeof payload !== 'object' || !payload.team || payload.team.id !== teamId) return refuse(403, 'wrong_workspace');
      const reviewer = reviewerFor(String((payload.user && payload.user.id) || ''));
      const nowIso = now().toISOString();
      if (payload.type === 'block_actions') return pressed(payload, reviewer, nowIso);
      if (payload.type === 'view_submission' && payload.view && payload.view.callback_id === 'notes_save') {
        return notesSaved(payload, reviewer, nowIso);
      }
      return ok;
    },
  };
}
