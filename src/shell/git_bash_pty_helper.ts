import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const runtimeRequire = createRequire(import.meta.url);

const HELPER_SOURCE = String.raw`"use strict";

const nodePtyEntry = process.env.DEVSPACE_NODE_PTY_ENTRY;
if (!nodePtyEntry) {
  process.stderr.write("DEVSPACE_PTY_HELPER_ERROR: missing DEVSPACE_NODE_PTY_ENTRY\\n");
  process.exit(70);
}

let payload;
try {
  payload = JSON.parse(Buffer.from(process.argv[2] || "", "base64").toString("utf8"));
} catch (err) {
  process.stderr.write("DEVSPACE_PTY_HELPER_ERROR: invalid payload: " + String(err) + "\\n");
  process.exit(64);
}

let pty;
try {
  pty = require(nodePtyEntry);
} catch (err) {
  process.stderr.write("DEVSPACE_PTY_HELPER_ERROR: failed loading node-pty: " + String(err) + "\\n");
  process.exit(69);
}

let term;
try {
  term = pty.spawn(payload.shell, payload.args || [], {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd: payload.cwd,
    env: payload.env || process.env,
    useConpty: true
  });
} catch (err) {
  process.stderr.write("DEVSPACE_PTY_HELPER_ERROR: spawn failed: " + String(err) + "\\n");
  process.exit(71);
}

let exiting = false;

process.stdin.on("data", (chunk) => {
  if (exiting) return;
  try {
    term.write(chunk);
  } catch (err) {
    process.stderr.write("DEVSPACE_PTY_HELPER_ERROR: input write failed: " + String(err) + "\\n");
  }
});

term.onData((data) => {
  if (exiting) return;
  try {
    process.stdout.write(data);
  } catch {}
});

term.onExit((event) => {
  if (exiting) return;
  exiting = true;
  const code = Number.isFinite(event && event.exitCode) ? Number(event.exitCode) : -1;
  const marker = String.fromCharCode(30) + "DEVSPACE_PTY_EXIT:" + code + String.fromCharCode(30) + String.fromCharCode(10);
  try {
    process.stderr.write(marker, () => {
      setImmediate(() => process.exit(0));
    });
  } catch {
    process.exit(0);
  }
  const fallback = setTimeout(() => process.exit(0), 100);
  if (typeof fallback.unref === "function") fallback.unref();
});

process.on("SIGTERM", () => {
  try { term.kill(); } catch {}
  process.exit(143);
});
`;

let cachedHelperPath: string | undefined;

function cacheDirectory(): string {
  const dir = path.join(os.tmpdir(), "devspace4", "git-bash-pty-helper");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface GitBashPtyHelperLaunch {
  helperPath: string;
  nodePtyEntry: string;
}

export function ensureGitBashPtyHelper(): GitBashPtyHelperLaunch {
  const nodePtyEntry = runtimeRequire.resolve("node-pty");
  const hash = crypto.createHash("sha256").update(HELPER_SOURCE).digest("hex").slice(0, 16);
  const helperPath = path.join(cacheDirectory(), `helper-${hash}.cjs`);

  if (!cachedHelperPath || cachedHelperPath !== helperPath || !fs.existsSync(helperPath)) {
    const tempPath = `${helperPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, HELPER_SOURCE, "utf8");
    try {
      fs.renameSync(tempPath, helperPath);
    } catch (err) {
      if (!fs.existsSync(helperPath)) throw err;
      try { fs.rmSync(tempPath, { force: true }); } catch {}
    }
    cachedHelperPath = helperPath;
  }

  return { helperPath, nodePtyEntry };
}

export function encodeGitBashPtyPayload(
  shell: string,
  cwd: string,
  args: string[]
): string {
  return Buffer.from(JSON.stringify({ shell, cwd, args }), "utf8").toString("base64");
}

export function extractGitBashPtyControl(stderr: string): {
  exitCode?: number;
  stderr: string;
} {
  let exitCode: number | undefined;
  const cleaned = stderr.replace(
    /\x1eDEVSPACE_PTY_EXIT:(-?\d+)\x1e\r?\n?/g,
    (_match, rawCode: string) => {
      const parsed = Number.parseInt(rawCode, 10);
      if (Number.isFinite(parsed)) exitCode = parsed;
      return "";
    }
  );
  return { exitCode, stderr: cleaned };
}
