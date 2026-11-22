// The emails applicants get, and who sends each one.
//
// One is sent by this service itself: the receipt, the moment an application
// is saved. It says we have it and nothing about the outcome.
//
// The other three are sent by a reviewer, by hand: the invite to an intro
// call, the welcome after an approval, and the note after a decline. For
// those the service only writes the draft and opens it in the reviewer's own
// Gmail, so each is read by a person and goes out from their own address.
// The reviewer then records that it was sent.
//
// To change the wording, edit the text below. To add the booking link, set
// CALL_BOOKING_URL (see README.md, "The intro call").

const GMAIL_COMPOSE = 'https://mail.google.com/mail/';

export const RECEIPT_SUBJECT = 'We got your Homology application';
export const CALL_INVITE_SUBJECT = 'Homology | quick intro call';
export const WELCOME_SUBJECT = 'Welcome to Homology';
export const DECLINE_SUBJECT = 'Your Homology application';
export const SIGN_OFF = 'Adarsh and Arthur';

// "Jane" from "Jane Smith". Anything that does not look like a first name
// ("Dr.", "J", a handle) gets a neutral greeting, since the reviewer may not notice.
export function firstName(fullName) {
  const first = String(fullName ?? '').trim().split(/\s+/)[0] || '';
  return /^[\p{L}][\p{L}'’-]{1,39}$/u.test(first) ? first : '';
}

const greeting = (app) => {
  const name = firstName(app.answers.fullName);
  return name ? `Hi ${name},` : 'Hi there,';
};

const letter = (app, subject, paragraphs) => ({
  to: app.answers.email,
  subject,
  body: [greeting(app), ...paragraphs, SIGN_OFF].join('\n\n'),
});

// Sent automatically when an application is saved. The applicant's name is
// the only thing in it that they typed, and firstName() lets through letters
// only, so nobody can use the form to make us send their own text to someone.
export function receiptEmail(app) {
  return letter(app, RECEIPT_SUBJECT, [
    'We got your application to Homology. Thanks for sending it in.',
    "We read every one ourselves, so you'll hear back from us soon. Keep an eye out for an email from us.",
  ]);
}

// The note inviting an applicant to a short call. With a booking link it
// points there. Without one it asks for a couple of times instead, so the
// call stage works before the link exists.
export function callInviteEmail(app, { bookingUrl = '' } = {}) {
  return letter(app, CALL_INVITE_SUBJECT, [
    'Thanks for applying to Homology. We read your application and would like to get to know you a bit before adding you to the community.',
    bookingUrl
      ? `Do you have 15 minutes for a quick call? You can pick a time here:\n${bookingUrl}`
      : "Do you have 15 minutes for a quick call in the next week or two? Send over a couple of times that work and we'll confirm one.",
    "Mostly we want to hear what you're working on and who you'd want to meet, so the introductions we make are useful to you.",
  ]);
}

// Sent after an approval. It tells them the Slack invitation is a separate
// message that follows, because that one comes from Slack, not from us.
export function welcomeEmail(app) {
  return letter(app, WELCOME_SUBJECT, [
    "You're in. Welcome to Homology.",
    "You'll get a Slack invitation at this address shortly. That's where the community talks day to day, so accept it when it arrives and say hello.",
    "We'll also reach out with introductions as we come across people you should meet.",
  ]);
}

// Sent after a decline. Short, and it gives no reason, because the service
// cannot know the real one. The reviewer adds one if they want to.
export function declineEmail(app) {
  return letter(app, DECLINE_SUBJECT, [
    'Thanks for applying to Homology and for telling us about your work.',
    "We aren't able to offer you a place right now. You're welcome to apply again down the line, especially if what you're working on changes.",
  ]);
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

// Every draft a reviewer might need for one application. `maxLength` is for
// places that cap how long a link can be: a draft that would not fit opens
// with the address and subject only.
export function draftUrls(app, { bookingUrl = '', authuser = '', maxLength = Infinity } = {}) {
  const link = (email) => {
    const full = gmailDraftUrl(email, { authuser });
    return full.length <= maxLength ? full : gmailDraftUrl({ ...email, body: '' }, { authuser });
  };
  return {
    call: link(callInviteEmail(app, { bookingUrl })),
    welcome: link(welcomeEmail(app)),
    decline: link(declineEmail(app)),
  };
}
