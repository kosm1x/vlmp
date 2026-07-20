import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

// Keys the tests (or applyEnvFile) may touch — snapshotted and restored so
// loadConfig's process.env mutation can't leak between tests.
const TOUCHED = [
  "VLMP_DATA_DIR",
  "VLMP_JWT_SECRET",
  "VLMP_JWT_SECRET_FILE",
  "VLMP_SERVER_NAME",
  "VLMP_PORT",
  "VLMP_TRANSCODE_PRESET",
];

let saved: Record<string, string | undefined>;
let dataDir: string;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
  dataDir = mkdtempSync(join(tmpdir(), "vlmp-config-"));
  process.env.VLMP_DATA_DIR = dataDir;
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("vlmp.env config file", () => {
  it("applies VLMP_ keys from <dataDir>/vlmp.env", () => {
    writeFileSync(
      join(dataDir, "vlmp.env"),
      "# comment\n\nVLMP_SERVER_NAME=From File\nVLMP_PORT=9123\n",
    );
    const config = loadConfig();
    expect(config.serverName).toBe("From File");
    expect(config.port).toBe(9123);
  });

  it("real environment variables win over the file", () => {
    process.env.VLMP_SERVER_NAME = "From Env";
    writeFileSync(join(dataDir, "vlmp.env"), "VLMP_SERVER_NAME=From File\n");
    expect(loadConfig().serverName).toBe("From Env");
  });

  it("ignores non-VLMP keys and VLMP_DATA_DIR", () => {
    writeFileSync(
      join(dataDir, "vlmp.env"),
      `NODE_OPTIONS=--evil\nPATH=C:\\evil\nVLMP_DATA_DIR=${join(dataDir, "elsewhere")}\n`,
    );
    const before = process.env.NODE_OPTIONS;
    const config = loadConfig();
    expect(process.env.NODE_OPTIONS).toBe(before);
    expect(config.dataDir).toBe(dataDir);
  });

  it("tolerates a missing file and CRLF line endings", () => {
    expect(() => loadConfig()).not.toThrow();
    writeFileSync(
      join(dataDir, "vlmp.env"),
      "VLMP_SERVER_NAME=CRLF Server\r\nVLMP_TRANSCODE_PRESET=fast\r\n",
    );
    const config = loadConfig();
    expect(config.serverName).toBe("CRLF Server");
    expect(config.transcodePreset).toBe("fast");
  });
});

describe("VLMP_JWT_SECRET_FILE", () => {
  it("reads and trims the secret from the file", () => {
    const secretPath = join(dataDir, "jwt.secret");
    writeFileSync(secretPath, "  file-secret-value \n");
    process.env.VLMP_JWT_SECRET_FILE = secretPath;
    expect(loadConfig().jwtSecret).toBe("file-secret-value");
  });

  it("VLMP_JWT_SECRET takes precedence over the file", () => {
    const secretPath = join(dataDir, "jwt.secret");
    writeFileSync(secretPath, "file-secret");
    process.env.VLMP_JWT_SECRET_FILE = secretPath;
    process.env.VLMP_JWT_SECRET = "env-secret";
    expect(loadConfig().jwtSecret).toBe("env-secret");
  });

  it("throws when the file is missing or empty (no silent dev-default)", () => {
    process.env.VLMP_JWT_SECRET_FILE = join(dataDir, "nope.secret");
    expect(() => loadConfig()).toThrow(/unreadable/);
    const emptyPath = join(dataDir, "empty.secret");
    writeFileSync(emptyPath, "\n");
    process.env.VLMP_JWT_SECRET_FILE = emptyPath;
    expect(() => loadConfig()).toThrow(/empty/);
  });
});
