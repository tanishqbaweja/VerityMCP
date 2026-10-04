import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../security/roots.js";
import type { StandardToolResponse } from "../types/index.js";

export interface ListDirectoryOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  dirPath?: string;
  recursive?: boolean;
  maxDepth?: number;
  showHidden?: boolean;
  ignoreCommonDirs?: boolean;
}

export interface DirEntryInfo {
  name: string;
  relativePath: string;
  type: "file" | "directory" | "symlink" | "other";
  sizeBytes?: number;
  modifiedAt?: string;
}

export interface ListDirectoryData {
  directory: string;
  entries: DirEntryInfo[];
  totalCount: number;
  fileCount: number;
  directoryCount: number;
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

export async function executeListDirectory(
  options: ListDirectoryOptions
): Promise<StandardToolResponse<ListDirectoryData>> {
  const startTime = Date.now();
  const {
    workspaceRoot,
    allowedRoots = [],
    dirPath = ".",
    recursive = false,
    maxDepth = 2,
    showHidden = false,
    ignoreCommonDirs = true,
  } = options;

  let resolvedDir: string;
  try {
    resolvedDir = resolveWorkspacePath(workspaceRoot, dirPath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      action: `list_directory "${dirPath}"`,
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

  let stat;
  try {
    stat = await fs.stat(resolvedDir);
  } catch (err: any) {
    return {
      success: false,
      action: `list_directory "${dirPath}"`,
      text: `Directory "${dirPath}" does not exist: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "fs_stat_check",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  if (!stat.isDirectory()) {
    return {
      success: false,
      action: `list_directory "${dirPath}"`,
      text: `"${dirPath}" is a file, not a directory. Use read_file instead.`,
      verification: {
        performed: true,
        passed: false,
        method: "fs_stat_isDirectory",
        error: "Not a directory",
      },
      durationMs: Date.now() - startTime,
    };
  }

  const entries: DirEntryInfo[] = [];

  async function scan(currentDir: string, currentDepth: number) {
    if (currentDepth > (recursive ? maxDepth : 1)) return;

    let dirFiles: string[] = [];
    try {
      dirFiles = await fs.readdir(currentDir);
    } catch {
      return;
    }

    for (const name of dirFiles) {
      if (!showHidden && name.startsWith(".")) continue;
      if (ignoreCommonDirs && COMMON_IGNORE.has(name) && currentDepth > 0) continue;

      const fullItemPath = path.join(currentDir, name);
      const relToWorkspace = path.relative(workspaceRoot, fullItemPath).replace(/\\/g, "/");

      let itemStat;
      try {
        itemStat = await fs.stat(fullItemPath);
      } catch {
        continue;
      }

      const isDir = itemStat.isDirectory();
      const isFile = itemStat.isFile();
      const type: DirEntryInfo["type"] = isDir
        ? "directory"
        : isFile
        ? "file"
        : itemStat.isSymbolicLink()
        ? "symlink"
        : "other";

      entries.push({
        name,
        relativePath: relToWorkspace,
        type,
        sizeBytes: isFile ? itemStat.size : undefined,
        modifiedAt: itemStat.mtime.toISOString(),
      });

      if (recursive && isDir && currentDepth < maxDepth) {
        if (!ignoreCommonDirs || !COMMON_IGNORE.has(name)) {
          await scan(fullItemPath, currentDepth + 1);
        }
      }
    }
  }

  await scan(resolvedDir, 0);

  const fileCount = entries.filter((e) => e.type === "file").length;
  const directoryCount = entries.filter((e) => e.type === "directory").length;

  const lines = entries.map((e) => {
    const icon = e.type === "directory" ? "[DIR]" : "[FILE]";
    const size = e.sizeBytes !== undefined ? ` (${e.sizeBytes} B)` : "";
    return `${icon.padEnd(7)} ${e.relativePath}${size}`;
  });

  const header = `Directory: ${dirPath} (${entries.length} items: ${directoryCount} directories, ${fileCount} files)`;
  const text = `${header}\n${lines.slice(0, 300).join("\n")}${
    entries.length > 300 ? `\n... and ${entries.length - 300} more items` : ""
  }`;

  return {
    success: true,
    action: `list_directory "${dirPath}"`,
    text,
    verification: {
      performed: true,
      passed: true,
      method: "fs_readdir_scanned",
      details: { totalCount: entries.length, fileCount, directoryCount },
    },
    data: {
      directory: dirPath,
      entries,
      totalCount: entries.length,
      fileCount,
      directoryCount,
    },
    durationMs: Date.now() - startTime,
  };
}
