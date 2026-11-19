import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, LIMITS, normalizeLinkedin, validateApplication } from '../src/validate.js';
import { valid } from './helpers.js';

test('a complete application passes', () => {
  const r = validateApplication(valid());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, {});
});

test('every one of the eight fields is required', () => {
  assert.equal(FIELDS.length, 8);
  for (const field of FIELDS) {
    for (const empty of ['', '   ', undefined, null, 42]) {
      const r = validateApplication(valid({ [field]: empty }));
      assert.equal(r.ok, false, `${field} = ${JSON.stringify(empty)} should fail`);
      assert.deepEqual(Object.keys(r.errors), [field]);
    }
  }
});

test('an empty submission reports all eight fields', () => {
  const r = validateApplication({});
  assert.deepEqual(Object.keys(r.errors).sort(), [...FIELDS].sort());
});

test('email must look like an email', () => {
  for (const bad of ['nope', 'a@b', 'a b@c.org', '@c.org']) {
    assert.ok(validateApplication(valid({ email: bad })).errors.email, bad);
  }
});

test('LinkedIn must be a profile URL and is tidied', () => {
  assert.equal(normalizeLinkedin('linkedin.com/in/jane'), 'https://linkedin.com/in/jane');
  assert.equal(normalizeLinkedin('  HTTP://www.LinkedIn.com/in/jane/?utm=x#top '), 'https://www.linkedin.com/in/jane/');
  for (const bad of ['example.com/in/jane', 'linkedin.com', 'linkedin.com/company/acme', 'linkedin.com.evil.org/in/x', 'javascript:alert(1)', 'https://user:pw@linkedin.com/in/x']) {
    assert.equal(normalizeLinkedin(bad), null, bad);
    assert.ok(validateApplication(valid({ linkedinUrl: bad })).errors.linkedinUrl, bad);
  }
});

test('answers are kept as written', () => {
  const text = 'Line one.\r\n\r\n  Indented line with  two spaces.\tTab. Ünïcode ok.';
  const r = validateApplication(valid({ workingOn: `  ${text}  ` }));
  assert.equal(r.values.workingOn, 'Line one.\n\n  Indented line with  two spaces.\tTab. Ünïcode ok.');
});

test('each field has a length limit', () => {
  for (const field of FIELDS.filter((f) => f !== 'linkedinUrl' && f !== 'email')) {
    const r = validateApplication(valid({ [field]: 'x'.repeat(LIMITS[field] + 1) }));
    assert.ok(r.errors[field], field);
    assert.equal(validateApplication(valid({ [field]: 'x'.repeat(LIMITS[field]) })).ok, true, field);
  }
});

test('people without a company or a title can apply', () => {
  for (const roleAndOrg of ['Student', 'Independent researcher', 'Exploring my next step']) {
    assert.equal(validateApplication(valid({ roleAndOrg })).ok, true);
  }
});
