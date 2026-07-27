import type { ChildProcess } from "node:child_process";

/**
 * True only when the child genuinely exists and is still running.
 *
 * Do NOT use `ChildProcess.killed` for this. It records that a signal was SENT,
 * so it is false both for a process that is running and for one that exited or
 * never spawned — signalling on `!killed` therefore targets PIDs the kernel has
 * already reaped and possibly reassigned, and the signal lands on a stranger.
 *
 * Measured after an ENOENT spawn: `pid` undefined, `exitCode` -2,
 * `signalCode` null, `killed` **false**. All three fields below are needed:
 * `pid` catches the never-spawned case, `exitCode` the self-exited case, and
 * `signalCode` the already-signalled case.
 *
 * Lives in its own module rather than next to the transcoder because the
 * scanner, thumbnailer and encoder probe all need it, and transcoder.ts already
 * imports hw-encoders.ts — importing back would make that a cycle. This file
 * deliberately has no dependencies beyond a type.
 */
export function isProcessAlive(cp: ChildProcess): boolean {
  return cp.pid !== undefined && cp.exitCode === null && cp.signalCode === null;
}
