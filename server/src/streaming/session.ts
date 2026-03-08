import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import type { TranscodeProfile } from './adaptive.js';
import { startTranscode, type TranscodeJob } from './transcoder.js';

export interface StreamSession {
  id: string;
  mediaId: number;
  filePath: string;
  userId: string;
  profiles: TranscodeProfile[];
  jobs: Map<string, TranscodeJob>;
  createdAt: number;
  lastAccessed: number;
  directPlay: boolean;
}

const sessions = new Map<string, StreamSession>();
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function createSession(mediaId: number, filePath: string, userId: string, profiles: TranscodeProfile[], directPlay: boolean): StreamSession {
  const id = randomBytes(8).toString('hex');
  const session: StreamSession = { id, mediaId, filePath, userId, profiles, jobs: new Map(), createdAt: Date.now(), lastAccessed: Date.now(), directPlay };
  sessions.set(id, session);
  startCleanupTimer();
  return session;
}

export function getSession(id: string): StreamSession | undefined {
  const session = sessions.get(id);
  if (session) session.lastAccessed = Date.now();
  return session;
}

export function startProfileTranscode(session: StreamSession, profileName: string, config: Config, options?: { startTime?: number; audioTrack?: number }): TranscodeJob | null {
  const profile = session.profiles.find(p => p.name === profileName);
  if (!profile) return null;
  const existing = session.jobs.get(profileName);
  if (existing && !existing.process.killed) existing.process.kill('SIGTERM');
  const job = startTranscode(session.filePath, session.id, profile, config, options);
  session.jobs.set(profileName, job);
  return job;
}

export function destroySession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  for (const job of session.jobs.values()) { if (!job.process.killed) job.process.kill('SIGTERM'); }
  try {
    const firstJob = session.jobs.values().next().value;
    if (firstJob) { const sessionDir = join(firstJob.outputDir, '..'); rmSync(sessionDir, { recursive: true, force: true }); }
  } catch { /* best effort */ }
  sessions.delete(id);
}

export function getActiveSessions(): StreamSession[] { return Array.from(sessions.values()); }
export function getSessionCount(): number { return sessions.size; }

function cleanupIdleSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) { if (now - session.lastAccessed > IDLE_TIMEOUT_MS) destroySession(id); }
  if (sessions.size === 0 && cleanupInterval) { clearInterval(cleanupInterval); cleanupInterval = null; }
}

function startCleanupTimer(): void {
  if (!cleanupInterval) cleanupInterval = setInterval(cleanupIdleSessions, 60_000);
}

export function destroyAllSessions(): void {
  for (const id of sessions.keys()) destroySession(id);
  if (cleanupInterval) { clearInterval(cleanupInterval); cleanupInterval = null; }
}
