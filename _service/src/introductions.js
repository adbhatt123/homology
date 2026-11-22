// Introductions between members: the reason the community exists.
//
// A record says who was introduced to whom, why, where it stands and which
// reviewer made it. Nothing here sends anything. A reviewer writes the
// introduction themselves and records it, the same as the other emails.
//
// The rules, kept free of HTTP and storage so they can be read and tested
// on their own:
//   - An introduction is for one approved member.
//   - It is with another approved member, or with someone outside Homology,
//     who is recorded by name only. Never both, never the member themselves.
//   - It moves through: suggested, both asked, made, happened. "Both asked"
//     is its own step so each side can say yes before they are connected.
//     "Dropped" closes one that will not go ahead.
//   - Every change is kept with who made it and when.

import { DomainError } from './applications.js';
import { clean } from './validate.js';

export const INTRO_STATUSES = ['suggested', 'asked', 'made', 'happened', 'dropped'];
export const INTRO_STATUS_LABELS = {
  suggested: 'Suggested',
  asked: 'Both asked',
  made: 'Made',
  happened: 'Happened',
  dropped: 'Dropped',
};
export const REASON_LIMIT = 1000;
export const NAME_LIMIT = 120;
export const ABOUT_LIMIT = 200;

const ID = /^[0-9a-f-]{36}$/;

const reasonFrom = (value) => {
  if (value != null && typeof value !== 'string') throw new DomainError('invalid_reason', 'The reason must be text.');
  const text = clean(value);
  if (text.length > REASON_LIMIT) {
    throw new DomainError('reason_too_long', `Keep the reason under ${REASON_LIMIT.toLocaleString('en-US')} characters.`);
  }
  return text;
};

// Introductions are for people who are in. A pending, call-stage or declined
// applicant is not a member yet.
export function assertMember(app) {
  if (!app) throw new DomainError('unknown_member', 'That person is no longer on file.', 404);
  if (app.status !== 'approved') {
    throw new DomainError('not_a_member', 'Introductions are for approved members. Approve this application first.', 409);
  }
}

export function newIntroduction(input, admin, nowIso, id) {
  const src = input && typeof input === 'object' ? input : {};

  const forId = String(src.forId || '');
  if (!ID.test(forId)) throw new DomainError('invalid_member', 'Choose the member this introduction is for.');

  const withId = src.withId == null || src.withId === '' ? '' : String(src.withId);
  const outsideName = clean(src.outside && typeof src.outside === 'object' ? src.outside.name : '');
  const outsideAbout = clean(src.outside && typeof src.outside === 'object' ? src.outside.about : '');
  if (Boolean(withId) === Boolean(outsideName)) {
    throw new DomainError('invalid_other', 'Choose another member, or name someone outside Homology. One or the other.');
  }
  if (withId && !ID.test(withId)) throw new DomainError('invalid_member', 'Choose the member they are being introduced to.');
  if (withId && withId === forId) throw new DomainError('same_person', 'An introduction needs two different people.');
  if (outsideName.length > NAME_LIMIT) throw new DomainError('name_too_long', `Keep the name under ${NAME_LIMIT} characters.`);
  if (outsideAbout.length > ABOUT_LIMIT) throw new DomainError('about_too_long', `Keep the description under ${ABOUT_LIMIT} characters.`);

  const status = src.status == null || src.status === '' ? 'suggested' : String(src.status);
  if (!INTRO_STATUSES.includes(status)) throw new DomainError('invalid_status', 'Choose where this introduction stands.');

  return {
    id,
    schema: 1,
    createdAt: nowIso,
    createdBy: admin,
    forId,
    withId: withId || null,
    outside: outsideName ? { name: outsideName, about: outsideAbout } : null,
    reason: reasonFrom(src.reason),
    status,
    updatedAt: nowIso,
    updatedBy: admin,
    history: [{ at: nowIso, by: admin, action: 'created', to: status }],
  };
}

export function setIntroStatus(intro, status, admin, nowIso) {
  if (!INTRO_STATUSES.includes(status)) throw new DomainError('invalid_status', 'Choose where this introduction stands.');
  if (intro.status === status) return intro;
  intro.history.push({ at: nowIso, by: admin, action: 'status', from: intro.status, to: status });
  intro.status = status;
  intro.updatedAt = nowIso;
  intro.updatedBy = admin;
  return intro;
}

export function setIntroReason(intro, text, admin, nowIso) {
  if (typeof text !== 'string') throw new DomainError('invalid_reason', 'The reason must be text.');
  const value = reasonFrom(text);
  if (value === intro.reason) return intro;
  intro.history.push({ at: nowIso, by: admin, action: 'reason' });
  intro.reason = value;
  intro.updatedAt = nowIso;
  intro.updatedBy = admin;
  return intro;
}
