import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db/schema.js';
import { createGuestPass, validateGuestPass, generateGuestCode } from '../src/auth/guest.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); initSchema(db);
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)').run('admin', 'hash');
  db.prepare('INSERT INTO library_folders (id, path, category) VALUES (1, ?, ?)').run('/test', 'movies');
  db.prepare('INSERT INTO media_items (id, library_folder_id, type, file_path, title) VALUES (1, 1, ?, ?, ?)').run('movie', '/test/movie.mkv', 'Test Movie');
});
afterEach(() => { db.close(); });

describe('guest passes', () => {
  it('generates 8-char codes', () => { const c = generateGuestCode(); expect(c).toHaveLength(8); expect(/^[0-9a-f]+$/.test(c)).toBe(true); });
  it('creates and validates', () => {
    const pass = createGuestPass(db, 1, 1, 48, 3);
    const r = validateGuestPass(db, pass.code);
    expect(r.valid).toBe(true); expect(r.mediaId).toBe(1);
  });
  it('rejects invalid code', () => { expect(validateGuestPass(db, 'badcode1').valid).toBe(false); });
  it('rejects expired', () => {
    const pass = createGuestPass(db, 1, 1, 0, 3);
    db.prepare('UPDATE guest_passes SET expires_at = ? WHERE code = ?').run(0, pass.code);
    expect(validateGuestPass(db, pass.code).valid).toBe(false);
  });
  it('rejects max views reached', () => {
    const pass = createGuestPass(db, 1, 1, 48, 1);
    expect(validateGuestPass(db, pass.code).valid).toBe(true);
    expect(validateGuestPass(db, pass.code).valid).toBe(false);
  });
});
