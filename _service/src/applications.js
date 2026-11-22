// The rules of the membership flow, kept free of HTTP and storage so they can
// be read and tested on their own.
//
// These things are deliberately separate:
//   1. applying        creates a record with status "pending" and nothing else
//   2. the intro call  an optional stage: a reviewer moves the application to
//                      "call", invites the applicant to a short call by email,
//                      and records that the invite went out
//   3. approval        an admin decision, recorded with who and when. It can
//                      follow a call or skip it. After deciding, a reviewer
//                      emails the applicant a welcome or a decline note and
//                      records that it went out
//   4. invitation      a later, explicit admin step that is only possible once
//                      the application is approved
//
// One invariant ties them together: a Slack invitation can only be on record
// while the application is approved. A call, however it goes, grants nothing.

export const STATUSES = ['pending', 'call', 'approved', 'declined'];
export const STATUS_LABELS = { pending: 'Pending review', call: 'Intro call', approved: 'Approved', declined: 'Declined' };
export const INVITATION_STATUSES = ['not_sent', 'sent', 'joined'];
export const NOTES_LIMIT = 5000;

export class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const noCallInvite = () => ({ inviteSentBy: null, inviteSentAt: null });

// The call invite record, also for applications saved before the call stage existed.
export const callOf = (app) => app.call || noCallInvite();

// The email that follows a decision, and the decision it belongs to.
export const DECISION_EMAIL_STATUS = { welcome: 'approved', decline: 'declined' };
const noEmail = () => ({ sentBy: null, sentAt: null });
const noEmails = () => ({ welcome: noEmail(), decline: noEmail() });

// The record of those emails, also for applications saved before it existed.
export const emailsOf = (app) => ({ ...noEmails(), ...(app.emails || {}) });

export function newApplication(values, nowIso, id) {
  return {
    id,
    schema: 1,
    createdAt: nowIso,
    answers: { ...values },
    emailKey: values.email.toLowerCase(),
    status: 'pending',
    review: null,
    notes: { text: '', updatedBy: null, updatedAt: null },
    call: noCallInvite(),
    emails: noEmails(),
    invitation: {
      status: 'not_sent',
      method: null,
      sentBy: null,
      sentAt: null,
      joinedRecordedBy: null,
      joinedAt: null,
    },
    history: [{ at: nowIso, by: 'applicant', action: 'submitted' }],
  };
}

export function setStatus(app, status, admin, nowIso) {
  if (!STATUSES.includes(status)) {
    throw new DomainError('invalid_status', 'Status must be pending, call, approved or declined.');
  }
  if (app.status === status) return app;
  if (app.invitation.status !== 'not_sent') {
    throw new DomainError(
      'invitation_on_record',
      'A Slack invitation is on record for this applicant. Revoke it in Slack and clear the record before changing the decision.',
      409,
    );
  }
  app.history.push({ at: nowIso, by: admin, action: 'status', from: app.status, to: status });
  app.status = status;
  app.review = { by: admin, at: nowIso };
  return app;
}

export function setNotes(app, text, admin, nowIso) {
  if (typeof text !== 'string') throw new DomainError('invalid_notes', 'Notes must be text.');
  const value = text.replace(/\r\n?/g, '\n').trim();
  if (value.length > NOTES_LIMIT) {
    throw new DomainError('notes_too_long', `Notes must be under ${NOTES_LIMIT.toLocaleString('en-US')} characters.`);
  }
  if (value === app.notes.text) return app;
  app.notes = { text: value, updatedBy: admin, updatedAt: nowIso };
  app.history.push({ at: nowIso, by: admin, action: 'notes' });
  return app;
}

// The email inviting an applicant to a short intro call. A reviewer sends it
// from their own inbox, then records it here so the other reviewers know.
// action: "sent"   the invite has gone out. Only at the call stage.
//         "clear"  the record was made by mistake
export function recordCallInvite(app, action, admin, nowIso) {
  const call = callOf(app);

  if (action === 'clear') {
    if (!call.inviteSentAt) return app;
    app.history.push({ at: nowIso, by: admin, action: 'call_invite', from: 'sent', to: 'not_sent' });
    app.call = noCallInvite();
    return app;
  }

  if (action === 'sent') {
    if (app.status !== 'call') {
      throw new DomainError('not_at_call_stage', 'Move this application to the call stage before recording a call invite.', 409);
    }
    if (call.inviteSentAt) {
      throw new DomainError('already_recorded', 'A call invite is already on record for this applicant.', 409);
    }
    app.history.push({ at: nowIso, by: admin, action: 'call_invite', from: 'not_sent', to: 'sent' });
    app.call = { inviteSentBy: admin, inviteSentAt: nowIso };
    return app;
  }

  throw new DomainError('invalid_action', 'Action must be sent or clear.');
}

// The welcome that follows an approval and the note that follows a decline.
// A reviewer sends it from their own inbox, then records it here.
// kind:   "welcome" only for an approved application
//         "decline" only for a declined one
// action: "sent" or "clear"
// A record stays if the decision later changes, because the email did go out.
export function recordDecisionEmail(app, kind, action, admin, nowIso) {
  if (!Object.hasOwn(DECISION_EMAIL_STATUS, kind)) {
    throw new DomainError('invalid_email', 'Email must be welcome or decline.');
  }
  const emails = emailsOf(app);

  if (action === 'clear') {
    if (!emails[kind].sentAt) return app;
    app.history.push({ at: nowIso, by: admin, action: 'email', kind, from: 'sent', to: 'not_sent' });
    app.emails = { ...emails, [kind]: noEmail() };
    return app;
  }

  if (action === 'sent') {
    const needed = DECISION_EMAIL_STATUS[kind];
    if (app.status !== needed) {
      throw new DomainError(
        'wrong_status',
        kind === 'welcome'
          ? 'A welcome email can only be recorded for an approved application.'
          : 'A decline email can only be recorded for a declined application.',
        409,
      );
    }
    if (emails[kind].sentAt) {
      throw new DomainError('already_recorded', `A ${kind} email is already on record for this applicant.`, 409);
    }
    app.history.push({ at: nowIso, by: admin, action: 'email', kind, from: 'not_sent', to: 'sent' });
    app.emails = { ...emails, [kind]: { sentBy: admin, sentAt: nowIso } };
    return app;
  }

  throw new DomainError('invalid_action', 'Action must be sent or clear.');
}

// action: "sent"   an admin has invited this one email address in Slack
//         "joined" the applicant accepted and is in the workspace
//         "clear"  the record was made by mistake, or the invitation was revoked
export function recordInvitation(app, action, admin, nowIso, method = 'manual') {
  const inv = app.invitation;

  if (action === 'clear') {
    if (inv.status === 'not_sent') return app;
    app.history.push({ at: nowIso, by: admin, action: 'invitation', from: inv.status, to: 'not_sent' });
    app.invitation = {
      status: 'not_sent',
      method: null,
      sentBy: null,
      sentAt: null,
      joinedRecordedBy: null,
      joinedAt: null,
    };
    return app;
  }

  if (app.status !== 'approved') {
    throw new DomainError('not_approved', 'Only approved applicants can be invited to Slack.', 409);
  }

  if (action === 'sent') {
    if (inv.status !== 'not_sent') {
      throw new DomainError('already_recorded', 'An invitation is already on record for this applicant.', 409);
    }
    app.history.push({ at: nowIso, by: admin, action: 'invitation', from: 'not_sent', to: 'sent', method });
    app.invitation = { ...inv, status: 'sent', method, sentBy: admin, sentAt: nowIso };
    return app;
  }

  if (action === 'joined') {
    if (inv.status !== 'sent') {
      throw new DomainError('not_invited', 'Record the invitation before marking the applicant as joined.', 409);
    }
    app.history.push({ at: nowIso, by: admin, action: 'invitation', from: 'sent', to: 'joined' });
    app.invitation = { ...inv, status: 'joined', joinedRecordedBy: admin, joinedAt: nowIso };
    return app;
  }

  throw new DomainError('invalid_action', 'Action must be sent, joined or clear.');
}
