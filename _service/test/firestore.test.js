// The production store, run against a stand-in that behaves like the parts of
// Firestore it uses. This checks our code, not Google's service: the real
// database is checked with a smoke test at deploy time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FirestoreStore } from '../src/store.js';
import { newApplication, recordInvitation, setStatus } from '../src/applications.js';
import { validateApplication } from '../src/validate.js';
import { valid } from './helpers.js';

function fakeFirestore() {
  const data = new Map();
  const assertPlain = (value, path = 'doc') => {
    if (value === undefined) throw new Error(`Firestore rejects undefined at ${path}`);
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertPlain(v, `${path}.${k}`);
  };
  const snap = (id) => ({ exists: data.has(id), data: () => structuredClone(data.get(id)) });
  const ref = (id) => ({
    id,
    create: async (doc) => {
      if (data.has(id)) throw new Error('ALREADY_EXISTS');
      assertPlain(doc);
      data.set(id, structuredClone(doc));
    },
    get: async () => snap(id),
  });
  return {
    data,
    collection: () => ({
      doc: ref,
      where: (field, op, value) => ({
        limit: () => ({
          get: async () => {
            if (op !== '==') throw new Error('only == is used');
            return { docs: [...data.keys()].filter((id) => data.get(id)[field] === value).map(snap) };
          },
        }),
      }),
      orderBy: (field, dir) => ({
        limit: () => ({
          get: async () => ({
            docs: [...data.keys()]
              .sort((a, b) => (data.get(a)[field] < data.get(b)[field] ? 1 : -1) * (dir === 'desc' ? 1 : -1))
              .map(snap),
          }),
        }),
      }),
    }),
    runTransaction: async (fn) =>
      fn({
        get: async (r) => snap(r.id),
        set: (r, doc) => {
          assertPlain(doc);
          data.set(r.id, structuredClone(doc));
        },
      }),
  };
}

test('the production store saves, lists newest first and updates in a transaction', async () => {
  const firestore = fakeFirestore();
  const store = new FirestoreStore({ database: 'homology', collection: 'applications', firestore });

  const older = newApplication(validateApplication(valid()).values, '2026-11-19T15:00:00.000Z', 'a'.repeat(36));
  const newer = newApplication(validateApplication(valid({ email: 'b@example.org' })).values, '2026-11-19T16:00:00.000Z', 'b'.repeat(36));
  await store.create(older);
  await store.create(newer);
  await assert.rejects(() => store.create(older), /ALREADY_EXISTS/);

  assert.deepEqual((await store.list()).map((d) => d.id), [newer.id, older.id]);
  assert.deepEqual(await store.get(older.id), older);
  assert.deepEqual((await store.listByEmail('b@example.org')).map((d) => d.id), [newer.id]);
  assert.deepEqual(await store.listByEmail('nobody@example.org'), []);
  assert.equal(await store.get('missing'), null);
  assert.equal(await store.update('missing', (d) => d), null);

  const t = '2026-11-19T17:00:00.000Z';
  await store.update(older.id, (d) => setStatus(d, 'approved', 'reviewer@example.org', t));
  await store.update(older.id, (d) => recordInvitation(d, 'sent', 'reviewer@example.org', t));
  await store.update(older.id, (d) => recordInvitation(d, 'joined', 'reviewer@example.org', t));
  await store.update(older.id, (d) => recordInvitation(d, 'clear', 'reviewer@example.org', t));
  const saved = await store.get(older.id);
  assert.equal(saved.status, 'approved');
  assert.equal(saved.invitation.status, 'not_sent');
  assert.equal(saved.history.length, 5);

  // A rule that refuses a change leaves the saved copy untouched.
  await assert.rejects(() => store.update(newer.id, (d) => recordInvitation(d, 'sent', 'reviewer@example.org', t)), /approved/);
  assert.equal((await store.get(newer.id)).invitation.status, 'not_sent');
});
