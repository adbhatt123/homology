// Emails a reviewer sends by hand.
//
// This service never sends email. It writes the draft and opens it in the
// reviewer's own Gmail, so every message is read by a person and goes out
// from their own address. The reviewer then records that it was sent.
//
// To change the wording, edit the text below. To add the booking link, set
// CALL_BOOKING_URL (see README.md, "The intro call").

const GMAIL_COMPOSE = 'https://mail.google.com/mail/';

export const CALL_INVITE_SUBJECT = 'Homology | quick intro call';
export const SIGN_OFF = 'Adarsh and Arthur';

// "Jane" from "Jane Smith". Anything that does not look like a first name
// ("Dr.", "J", a handle) gets a neutral greeting, since the reviewer may not notice.
export function firstName(fullName) {
  const first = String(fullName ?? '').trim().split(/\s+/)[0] || '';
  return /^[\p{L}][\p{L}'’-]{1,39}$/u.test(first) ? first : '';
}

// The note inviting an applicant to a short call. With a booking link it
// points there. Without one it asks for a couple of times instead, so the
// call stage works before the link exists.
export function callInviteEmail(app, { bookingUrl = '' } = {}) {
  const name = firstName(app.answers.fullName);
  const ask = bookingUrl
    ? ['Do you have 15 minutes for a quick call? You can pick a time here:', bookingUrl]
    : ['Do you have 15 minutes for a quick call in the next week or two? Send over a couple of times that work and we will confirm one.'];
  const body = [
    name ? `Hi ${name},` : 'Hi there,',
    '',
    'Thanks for applying to Homology. We read your application and would like to get to know you a bit before adding you to the community.',
    '',
    ...ask,
    '',
    'Mostly we want to hear what you are working on and who you would want to meet, so the introductions we make are useful to you.',
    '',
    SIGN_OFF,
  ].join('\n');
  return { to: app.answers.email, subject: CALL_INVITE_SUBJECT, body };
}

// A link that opens a ready-to-send draft in Gmail. Nothing is sent by
// following it. `authuser` picks which signed-in Google account writes it.
export function gmailDraftUrl({ to, subject, body }, { authuser = '' } = {}) {
  const params = new URLSearchParams();
  if (authuser) params.set('authuser', authuser);
  params.set('view', 'cm');
  params.set('fs', '1');
  params.set('to', to);
  params.set('su', subject);
  if (body) params.set('body', body);
  return `${GMAIL_COMPOSE}?${params.toString()}`;
}
