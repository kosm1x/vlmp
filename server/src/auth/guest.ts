import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

export function generateGuestCode(): string {
  return randomBytes(4).toString('hex');
}

export function createGuestPass(
  db: Database.Database, mediaId: number, userId: number,
  expiresInHours: number = 48, maxViews: number = 3,
): { code: string; expires_at: number } {
  const code = generateGuestCode();
  const expires_at = Math.floor(Date.now() / 1000) + (expiresInHours * 3600);
  db.prepare('INSERT INTO guest_passes (code, media_id, created_by, expires_at, max_views) VALUES (?, ?, ?, ?, ?)')
    .run(code, mediaId, userId, expires_at, maxViews);
  return { code, expires_at };
}

export function validateGuestPass(db: Database.Database, code: string): { valid: boolean; mediaId?: number } {
  const pass = db.prepare('SELECT media_id, expires_at, max_views, views FROM guest_passes WHERE code = ?')
    .get(code) as { media_id: number; expires_at: number; max_views: number; views: number } | undefined;
  if (!pass) return { valid: false };
  const now = Math.floor(Date.now() / 1000);
  if (now > pass.expires_at) return { valid: false };
  if (pass.views >= pass.max_views) return { valid: false };
  db.prepare('UPDATE guest_passes SET views = views + 1 WHERE code = ?').run(code);
  return { valid: true, mediaId: pass.media_id };
}
