import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";

function readStoredToken(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
    ownerToken?: unknown;
    token?: unknown;
  };
  const candidate = saved.ownerToken ?? saved.token;
  return typeof candidate === "string" && candidate.trim()
    ? candidate
    : undefined;
}

/**
 * Resolve the owner password in the same order for every startup mode:
 * environment override, project .verity/auth.json, legacy ~/.verity/auth.json.
 *
 * If there is no existing credential, persist a cryptographically random
 * password in the ignored project data directory before exposing HTTP/MCP.
 * Never silently launch an unauthenticated service when provisioning fails.
 */
export function resolveOwnerToken(
  persistentDataRoot: string,
  homeDirectory = os.homedir(),
  environmentToken = process.env.VERITY_OWNER_TOKEN,
): string {
  if (environmentToken?.trim()) return environmentToken;

  const localPath = path.join(persistentDataRoot, "auth.json");
  const legacyPath = path.join(homeDirectory, ".verity", "auth.json");

  for (const candidate of [localPath, legacyPath]) {
    try {
      const existing = readStoredToken(candidate);
      if (existing) return existing;
    } catch (error) {
      throw new Error(`Unable to read owner credentials at ${candidate}. Refusing to run without authentication.`, {
        cause: error,
      });
    }
  }

  // Never clobber an existing credentials file that could contain unrelated
  // settings or be corrupt. Creation is exclusive to avoid racing startups.
  fs.mkdirSync(persistentDataRoot, { recursive: true });
  const generated = randomBytes(32).toString("base64url");
  const body = JSON.stringify({ ownerToken: generated }, null, 2) + "\n";
  try {
    fs.writeFileSync(localPath, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return generated;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Another process may have created it concurrently. Reuse that token.
      const existing = readStoredToken(localPath);
      if (existing) return existing;
    }
    throw new Error(`Unable to provision owner credentials at ${localPath}. Refusing to run without authentication.`, {
      cause: error,
    });
  }
}
