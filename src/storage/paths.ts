import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedServerRoot: string | null = null;
let cachedDataRoot: string | null = null;

/**
 * Robustly resolve the canonical VerityMCP server root directory.
 * Priority:
 * 1. VERITY_ROOT environment variable (explicit override)
 * 2. Walk up directory tree from this module to find package.json with name "verity-mcp"
 * 3. Walk up directory tree to find any package.json
 * 4. Fallback to process.cwd()
 */
export function getServerRoot(): string {
  if (process.env.VERITY_ROOT) {
    return path.resolve(process.env.VERITY_ROOT);
  }

  if (cachedServerRoot) {
    return cachedServerRoot;
  }

  try {
    const currentFile = fileURLToPath(import.meta.url);
    let dir = path.dirname(currentFile);

    while (dir && dir !== path.dirname(dir)) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          if (pkg.name === "verity-mcp") {
            cachedServerRoot = dir;
            return dir;
          }
        } catch {}
      }
      dir = path.dirname(dir);
    }

    // Secondary scan: any package.json
    dir = path.dirname(currentFile);
    while (dir && dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, "package.json"))) {
        cachedServerRoot = dir;
        return dir;
      }
      dir = path.dirname(dir);
    }
  } catch {}

  const fallback = process.cwd();
  cachedServerRoot = fallback;
  return fallback;
}

/**
 * Canonical persistent state root.
 * Strict rule: NEVER AppData, NEVER LocalAppData, NEVER user workspace.
 * Always <server_root>/.verity, unless explicitly overridden via VERITY_DATA_DIR.
 */
export function getPersistentDataRoot(): string {
  if (process.env.VERITY_DATA_DIR) {
    return path.resolve(process.env.VERITY_DATA_DIR);
  }

  if (process.env.VERITY_ROOT) {
    return path.join(path.resolve(process.env.VERITY_ROOT), ".verity");
  }

  if (cachedDataRoot) {
    return cachedDataRoot;
  }

  const serverRoot = getServerRoot();
  const root = path.join(serverRoot, ".verity");
  cachedDataRoot = root;
  return root;
}

export function getRunsDir(): string {
  return path.join(getPersistentDataRoot(), "runs");
}

export function getStateDir(): string {
  return path.join(getPersistentDataRoot(), "state");
}

export function getActivityDir(): string {
  return path.join(getPersistentDataRoot(), "activity");
}

export function getLocksDir(): string {
  return path.join(getPersistentDataRoot(), "locks");
}

export function getArchivesDir(): string {
  return path.join(getPersistentDataRoot(), "archives");
}

export function getActiveRunPath(): string {
  return path.join(getStateDir(), "active-run.json");
}

export function getRunDirPath(runId: string): string {
  return path.join(getRunsDir(), runId);
}

/**
 * Ensure all canonical storage directories exist on disk synchronously or asynchronously.
 */
export function ensureDirectoriesExistSync(): void {
  const dirs = [
    getPersistentDataRoot(),
    getRunsDir(),
    getStateDir(),
    getActivityDir(),
    getLocksDir(),
    getArchivesDir(),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

export async function ensureDirectoriesExist(): Promise<void> {
  const dirs = [
    getPersistentDataRoot(),
    getRunsDir(),
    getStateDir(),
    getActivityDir(),
    getLocksDir(),
    getArchivesDir(),
  ];
  for (const dir of dirs) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

/**
 * Calculate disk usage of the persistent .verity directory.
 */
export async function getPersistentDiskUsageBytes(): Promise<number> {
  const root = getPersistentDataRoot();
  if (!fs.existsSync(root)) return 0;

  let totalBytes = 0;
  async function scan(dir: string): Promise<void> {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scan(fullPath);
        } else if (entry.isFile()) {
          const stat = await fsp.stat(fullPath);
          totalBytes += stat.size;
        }
      }
    } catch {}
  }

  await scan(root);
  return totalBytes;
}

/**
 * Synchronous calculation of persistent .verity directory disk usage.
 */
export function getPersistentDiskUsageBytesSync(): number {
  const root = getPersistentDataRoot();
  if (!fs.existsSync(root)) return 0;

  let totalBytes = 0;
  function scan(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath);
        } else if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          totalBytes += stat.size;
        }
      }
    } catch {}
  }

  scan(root);
  return totalBytes;
}
