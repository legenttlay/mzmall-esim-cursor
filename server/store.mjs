import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Per-OS-user storage. Neither credentials nor transaction journals belong in
// the public plugin. A persisted attempt is never silently retried after restart.
export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = join(directory, 'vault.key');
    // Cursor can spawn multiple instances while loading/reloading plugins.
    // Publish a completely written key atomically, and never replace a key
    // another instance has already created (or an existing customer's key).
    const pendingKey = join(directory, `.vault-key-init-${process.pid}-${randomBytes(8).toString('hex')}`);
    writeFileSync(pendingKey, randomBytes(32), { flag: 'wx', mode: 0o600 });
    try { linkSync(pendingKey, keyPath); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    finally { unlinkSync(pendingKey); }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('Invalid local vault key');
    this.db = new DatabaseSync(join(directory, 'state.db'));
    // Set the busy handler BEFORE journal/schema changes. Otherwise a second
    // first-run instance immediately fails with SQLITE_BUSY at initialization.
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, payload TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS locks (id TEXT PRIMARY KEY);');
  }
  seal(value) {
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', this.key, iv);
    const bytes = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), bytes]).toString('base64');
  }
  open(value) {
    const b = Buffer.from(value, 'base64'), d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
  }
  get(kind, id) { const row = this.db.prepare('SELECT payload FROM records WHERE kind=? AND id=?').get(kind, id); return row ? this.open(row.payload) : null; }
  put(kind, id, value) { this.db.prepare('INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload').run(kind, id, this.seal(value)); }
  delete(kind, id) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  async locked(id, fn) {
    try { this.db.prepare('INSERT INTO locks VALUES (?)').run(id); }
    catch { throw new Error('This operation is already running or needs recovery after an interruption. Check its status; do not purchase again.'); }
    try { return await fn(); } finally { this.db.prepare('DELETE FROM locks WHERE id=?').run(id); }
  }
  close() { this.db.close(); }
}
