import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import type { DevSpaceConfig } from "../types/index.js";

export function loadConfig(overrides?: Partial<DevSpaceConfig>): DevSpaceConfig {
  const port = parseInt(process.env.DEVSPACE_PORT || process.env.PORT || "7980", 10);
  const host = process.env.DEVSPACE_HOST || "127.0.0.1";
  const publicBaseUrl = process.env.DEVSPACE_PUBLIC_BASE_URL || "";

  // Probe owner token from ~/.devspace/auth.json or env
  let ownerToken = process.env.DEVSPACE_OWNER_TOKEN;
  if (!ownerToken) {
    try {
      const authPath = path.join(os.homedir(), ".devspace", "auth.json");
      if (fs.existsSync(authPath)) {
        const raw = fs.readFileSync(authPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.ownerToken) {
          ownerToken = parsed.ownerToken;
        } else if (parsed.token) {
          ownerToken = parsed.token;
        }
      }
    } catch {}
  }

  const allowedRootsEnv = process.env.DEVSPACE_ALLOWED_ROOTS;
  let allowedRoots: string[] = [];

  if (allowedRootsEnv) {
    allowedRoots = allowedRootsEnv.split(",").map((s) => path.resolve(s.trim()));
  } else {
    // Sensible defaults: current workspace and user drive roots
    allowedRoots = [
      process.cwd(),
      "H:\\Github Repositories",
      os.homedir(),
    ];
  }

  const worktreesDir =
    process.env.DEVSPACE_WORKTREES_DIR ||
    path.join(os.homedir(), ".devspace", "worktrees");

  return {
    port: overrides?.port ?? port,
    host: overrides?.host ?? host,
    publicBaseUrl: overrides?.publicBaseUrl ?? publicBaseUrl,
    ownerToken: overrides?.ownerToken ?? ownerToken,
    allowedRoots: overrides?.allowedRoots ?? allowedRoots,
    worktreesDir: overrides?.worktreesDir ?? worktreesDir,
  };
}
