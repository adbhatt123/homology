// The rules of the membership flow, kept free of HTTP and storage so they can
// be read and tested on their own.
//
// Three things are deliberately separate:
//   1. applying        creates a record with status "pending" and nothing else
//   2. approval        an admin decision, recorded with who and when
//   3. invitation      a later, explicit admin step that is only possible once
//                      the application is approved
//
// One invariant ties them together: an invitation can only be on record while
// the application is approved.

export const STATUSES = ['pending', 'approved', 'declined'];
export const STATUS_LABELS = { pending: 'Pending review', approved: 'Approved', declined: 'Declined' };
export const INVITATION_STATUSES = ['not_sent', 'sent', 'joined'];
export const NOTES_LIMIT = 5000;

export class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

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
    throw new DomainError('invalid_status', 'Status must be pending, approved or declined.');
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
