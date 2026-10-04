import fs from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { resolveWorkspacePath } from "../security/roots.js";
import type { StandardToolResponse } from "../types/index.js";

export interface LocateFilesOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  pattern: string;
  dirPath?: string;
  maxResults?: number;
  ignoreCommonDirs?: boolean;
}

export interface LocatedFileInfo {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface LocateFilesData {
  pattern: string;
  matches: LocatedFileInfo[];
  totalMatches: number;
}

const COMMON_IGNORE = new Set([
  ".git",
  "node_modules",
  ".pnpm",
  ".next",
  ".nuxt",
  "dist",
  "build",
  ".cache",
]);

export async function executeLocateFiles(
  options: LocateFilesOptions
): Promise<StandardToolResponse<LocateFilesData>> {
  const startTime = Date.now();
  const {
    workspaceRoot,
    allowedRoots = [],
    pattern,
    dirPath = ".",
    maxResults = 100,
    ignoreCommonDirs = true,
  } = options;

  let resolvedDir: string;
  try {
    resolvedDir = resolveWorkspacePath(workspaceRoot, dirPath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      action: `locate_files "${pattern}" in "${dirPath}"`,
      text: `Path validation failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "path_containment_check",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  // Compile matcher
  // Support simple substrings or globs
  const isGlob = /[*?[\]{}()]/.test(pattern);
  const matcher = picomatch(pattern, { nocase: true, dot: true });
  const lowerPattern = pattern.toLowerCase();

  const matches: LocatedFileInfo[] = [];

  async function walk(currentDir: string) {
    if (matches.length >= maxResults) return;

    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (matches.length >= maxResults) break;

      const name = ent.name;
      const fullPath = path.join(currentDir, name);
      const relPath = path.relative(workspaceRoot, fullPath).replace(/\\/g, "/");

      if (ent.isDirectory()) {
        if (ignoreCommonDirs && COMMON_IGNORE.has(name)) continue;
        await walk(fullPath);
      } else if (ent.isFile()) {
        const matchesName = isGlob
          ? matcher(name) || matcher(relPath)
          : name.toLowerCase().includes(lowerPattern) || relPath.toLowerCase().includes(lowerPattern);

        if (matchesName) {
          try {
            const st = await fs.stat(fullPath);
            matches.push({
              path: relPath,
              name,
              sizeBytes: st.size,
              modifiedAt: st.mtime.toISOString(),
            });
          } catch {}
        }
      }
    }
  }

  await walk(resolvedDir);

  const lines = matches.map((m) => `${m.path} (${m.sizeBytes} B)`);
  const header = `Found ${matches.length} file(s) matching "${pattern}" in "${dirPath}":`;
  const text = matches.length > 0 ? `${header}\n${lines.join("\n")}` : `No files found matching pattern "${pattern}".`;

  return {
    success: true,
    action: `locate_files "${pattern}"`,
    text,
    verification: {
      performed: true,
      passed: true,
      method: "fs_walk_pattern_matched",
      details: { pattern, matchCount: matches.length },
    },
    data: {
      pattern,
      matches,
      totalMatches: matches.length,
    },
    durationMs: Date.now() - startTime,
  };
}
