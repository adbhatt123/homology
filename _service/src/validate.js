// Validation for a membership application. The server is the authority; the
// public page repeats these rules only to give faster feedback.

export const LIMITS = {
  fullName: 120,
  email: 254,
  city: 120,
  linkedinUrl: 300,
  roleAndOrg: 200,
  workingOn: 1500,
  introWish: 1500,
  canHelpWith: 1500,
};

export const FIELDS = Object.keys(LIMITS);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Answers are kept as written. The only changes are ones a reader cannot see:
// consistent line endings, no control characters, no stray space at the ends.
export function clean(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

// Accepts "linkedin.com/in/name" with or without a scheme and returns a clean
// https URL, or null when it is not a LinkedIn profile.
export function normalizeLinkedin(raw) {
  let s = clean(raw);
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
  if (!/^\/(in|pub)\/[^/]+/.test(url.pathname)) return null;
  url.protocol = 'https:';
  url.search = '';
  url.hash = '';
  return url.toString();
}

const REQUIRED = {
  fullName: 'Please enter your full name.',
  email: 'Please enter your email address.',
  city: 'Please enter your city.',
  linkedinUrl: 'Please enter your LinkedIn profile URL.',
  roleAndOrg: 'Please enter your current role and organization.',
  workingOn: 'Please answer this question.',
  introWish: 'Please answer this question.',
  canHelpWith: 'Please answer this question.',
};

export function validateApplication(input) {
  const src = input && typeof input === 'object' ? input : {};
  const values = {};
  const errors = {};

  for (const field of FIELDS) {
    values[field] = clean(src[field]);
    if (!values[field]) errors[field] = REQUIRED[field];
  }

  if (!errors.email && !EMAIL.test(values.email)) {
    errors.email = 'Please enter a valid email address.';
  }

  if (!errors.linkedinUrl) {
    const url = normalizeLinkedin(values.linkedinUrl);
    if (url) values.linkedinUrl = url;
    else errors.linkedinUrl = 'Please enter a LinkedIn profile URL, for example linkedin.com/in/yourname.';
  }

  for (const field of FIELDS) {
    if (!errors[field] && values[field].length > LIMITS[field]) {
      errors[field] = `Please keep this under ${LIMITS[field].toLocaleString('en-US')} characters.`;
    }
  }

  return { ok: Object.keys(errors).length === 0, values, errors };
}
