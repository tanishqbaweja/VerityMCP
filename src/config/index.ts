import path from "node:path";
import os from "node:os";
import { resolveOwnerToken } from "./owner_token.js";
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

  // Provision a persistent first-run owner token before the HTTP server starts.
  // Existing env/local/legacy tokens take precedence and are never rotated here.
  const ownerToken = overrides?.ownerToken ?? resolveOwnerToken(persistentDataRoot);

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
    ownerToken,
    allowedRoots: overrides?.allowedRoots ?? allowedRoots,
    worktreesDir: overrides?.worktreesDir ?? worktreesDir,
    serverRoot: overrides?.serverRoot ?? serverRoot,
    persistentDataRoot: overrides?.persistentDataRoot ?? persistentDataRoot,
  };
}
