// Sends the one email this service sends by itself: the receipt an applicant
// gets when their application is saved (see src/emails.js).
//
// It goes out through Resend, a mail delivery service, from an address on
// homology.bio. Three settings switch it on together: RESEND_API_KEY,
// EMAIL_FROM and, optionally, EMAIL_REPLY_TO. Without them nothing is sent
// and everything else works as before.
//
// Only plain text is sent, to one recipient at a time. The subject, sender
// and reply address never come from an applicant.

const RESEND_API = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 2500;

export class MailError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function createMailer({ cfg, fetchImpl = fetch }) {
  if (!cfg.email.enabled) return null;
  const { apiKey, from, replyTo } = cfg.email;

  return {
    async send({ to, subject, body }) {
      let res;
      try {
        res = await fetchImpl(RESEND_API, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [to], subject, text: body, ...(replyTo ? { reply_to: replyTo } : {}) }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        throw new MailError('unreachable');
      }
      if (!res.ok) {
        // The service explains refusals in its reply. Keep only a short code:
        // the full text can repeat the recipient's address.
        let name = '';
        try {
          name = String((await res.json()).name || '');
        } catch {
          name = '';
        }
        throw new MailError(`${res.status}${/^[a-z_]{1,40}$/.test(name) ? `_${name}` : ''}`);
      }
    },
  };
}
