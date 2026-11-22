// Where applications are kept. Two interchangeable stores:
//   MemoryStore     local development and tests (optionally mirrored to a file)
//   FirestoreStore  production: a private Firestore database, reachable only
//                   by this service's own identity
//
// Both expose create / get / list / listByEmail / update. update() takes a
// function so a change is always applied to the latest saved copy.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export class MemoryStore {
  constructor({ file = '' } = {}) {
    this.file = file;
    this.docs = new Map();
    this.ready = this.load();
  }

  async load() {
    if (!this.file) return;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      for (const doc of saved) this.docs.set(doc.id, doc);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async save() {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify([...this.docs.values()], null, 2), { mode: 0o600 });
  }

  async create(doc) {
    await this.ready;
    if (this.docs.has(doc.id)) throw new Error('duplicate id');
    this.docs.set(doc.id, structuredClone(doc));
    await this.save();
    return doc;
  }

  async get(id) {
    await this.ready;
    const doc = this.docs.get(id);
    return doc ? structuredClone(doc) : null;
  }

  async list() {
    await this.ready;
    return [...this.docs.values()].map((doc) => structuredClone(doc));
  }

  // Every application from one email address (already lowercased).
  async listByEmail(emailKey) {
    return (await this.list()).filter((doc) => doc.emailKey === emailKey);
  }

  async update(id, change) {
    await this.ready;
    const current = this.docs.get(id);
    if (!current) return null;
    const next = change(structuredClone(current));
    this.docs.set(id, structuredClone(next));
    await this.save();
    return next;
  }
}

export class FirestoreStore {
  constructor({ database, collection, firestore }) {
    this.db = firestore;
    this.col = this.db.collection(collection);
    this.database = database;
  }

  static async connect({ database, collection, projectId }) {
    const { Firestore } = await import('@google-cloud/firestore');
    const firestore = new Firestore({ databaseId: database, ...(projectId ? { projectId } : {}) });
    return new FirestoreStore({ database, collection, firestore });
  }

  async create(doc) {
    await this.col.doc(doc.id).create(doc);
    return doc;
  }

  async get(id) {
    const snap = await this.col.doc(id).get();
    return snap.exists ? snap.data() : null;
  }

  async list() {
    const snap = await this.col.orderBy('createdAt', 'desc').limit(5000).get();
    return snap.docs.map((d) => d.data());
  }

  async listByEmail(emailKey) {
    const snap = await this.col.where('emailKey', '==', emailKey).limit(50).get();
    return snap.docs.map((d) => d.data());
  }

  async update(id, change) {
    const ref = this.col.doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const next = change(structuredClone(snap.data()));
      tx.set(ref, next);
      return next;
    });
  }
}
