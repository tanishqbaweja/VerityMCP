import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { VerityConfig } from "../types/index.js";
import {
  getServerRoot,
  getPersistentDataRoot,
  ensureDirectoriesExistSync,
} from "../storage/paths.js";

export function loadConfig(overrides?: Partial<VerityConfig>): VerityConfig {
  const port = parseInt(
    process.env.VERITY_PORT || process.env.PORT || "7980",
    10
  );
  const host = process.env.VERITY_HOST || "127.0.0.1";
  const publicBaseUrl = process.env.VERITY_PUBLIC_BASE_URL || "";

  const serverRoot = getServerRoot();
  const persistentDataRoot = getPersistentDataRoot();

  // Ensure persistent directories exist under <server_root>/.verity
  ensureDirectoriesExistSync();

  // Probe owner token from <persistentDataRoot>/auth.json or ~/.verity/auth.json or env
  let ownerToken = process.env.VERITY_OWNER_TOKEN;
  if (!ownerToken) {
    const candidates = [
      path.join(persistentDataRoot, "auth.json"),
      path.join(os.homedir(), ".verity", "auth.json"),
    ];

    for (const authPath of candidates) {
      try {
        if (fs.existsSync(authPath)) {
          const raw = fs.readFileSync(authPath, "utf-8");
          const parsed = JSON.parse(raw);
          if (parsed.ownerToken) {
            ownerToken = parsed.ownerToken;
            break;
          } else if (parsed.token) {
            ownerToken = parsed.token;
            break;
          }
        }
      } catch {}
    }
  }

  const allowedRootsEnv = process.env.VERITY_ALLOWED_ROOTS;
  let allowedRoots: string[] = [];

  if (allowedRootsEnv) {
    allowedRoots = allowedRootsEnv.split(",").map((s) => path.resolve(s.trim()));
  } else {
    // Sensible defaults: current workspace and user home directory
    allowedRoots = [process.cwd(), os.homedir()];
  }

  const worktreesDir =
    process.env.VERITY_WORKTREES_DIR ||
    path.join(persistentDataRoot, "worktrees");

  return {
    port: overrides?.port ?? port,
    host: overrides?.host ?? host,
    publicBaseUrl: overrides?.publicBaseUrl ?? publicBaseUrl,
    ownerToken: overrides?.ownerToken ?? ownerToken,
    allowedRoots: overrides?.allowedRoots ?? allowedRoots,
    worktreesDir: overrides?.worktreesDir ?? worktreesDir,
    serverRoot: overrides?.serverRoot ?? serverRoot,
    persistentDataRoot: overrides?.persistentDataRoot ?? persistentDataRoot,
  };
}
