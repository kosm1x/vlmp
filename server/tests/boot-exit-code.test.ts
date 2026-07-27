import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Boot the real entry point in a child process. Asserting on the EXIT CODE is
// the whole point: the bug this pins was invisible to every in-process test,
// because the server logged a fatal error and then exited 0 — which Docker's
// `restart: unless-stopped` and systemd's `Restart=on-failure` both read as an
// intentional stop.
const TSX = resolve(import.meta.dirname, "../../node_modules/tsx/dist/cli.mjs");
const ENTRY = resolve(import.meta.dirname, "../src/index.ts");

interface BootResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

function boot(env: Record<string, string>, timeoutMs = 45_000) {
  return new Promise<BootResult>((res, rej) => {
    const child = spawn(process.execPath, [TSX, ENTRY], {
      env: {
        ...process.env,
        VLMP_JWT_SECRET: "x".repeat(64),
        ...env,
      },
      // Bounded, and the signal escalates — a wedged child must never outlive
      // the test and hold the runner's pipe open. (See ci.yml's Test step.)
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", rej);
    child.on("close", (code, signal) => res({ code, signal, output }));
  });
}

describe("startup failures are fatal", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vlmp-boot-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits non-zero when the data directory cannot be created", async () => {
    // A FILE where a directory must be: mkdirSync throws ENOTDIR. Chosen over a
    // permissions denial because CI often runs as root, where chmod 000 is not
    // enforced and the fixture would silently stop discriminating.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");

    const { code, signal, output } = await boot({
      VLMP_DATA_DIR: join(blocker, "data"),
      // Never a real port: this must fail long before listen, and if it somehow
      // does not, binding something well out of the way beats a collision.
      VLMP_PORT: "18099",
    });

    expect(output).toMatch(/ENOTDIR|uncaughtException/);
    // Assert the signal FIRST. A process killed by the spawn timeout reports
    // code `null`, and `null` is not 0 — so a plain `not.toBe(0)` would have
    // passed on a boot that hung instead of exiting, which is the opposite
    // outcome from the one this test exists to prove.
    expect(signal, "must exit on its own, not be killed by the timeout").toBe(
      null,
    );
    expect(code, `expected exit 1, got code=${code} signal=${signal}`).toBe(1);
  }, 60_000);

  it("refuses to start without a JWT secret", async () => {
    // The one boot failure that was already handled correctly — kept so a
    // refactor of the guard cannot silently break the path that already worked.
    const { code, output } = await boot({
      VLMP_DATA_DIR: join(dir, "ok"),
      VLMP_PORT: "18099",
      VLMP_JWT_SECRET: "vlmp-dev-secret-change-me",
      NODE_ENV: "production",
    });

    expect(output).toMatch(/VLMP_JWT_SECRET must be set/);
    expect(code).toBe(1);
  }, 60_000);
});
