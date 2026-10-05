import fs from "node:fs/promises";
import path from "node:path";
import { resolvePathWithWorkspace } from "../security/roots.js";
import type { StandardToolResponse } from "../types/index.js";

export interface ListDirectoryOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  dirPath?: string;
  path?: string; // Alias for dirPath
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
  requested_path: string;
  resolved_path: string;
  within_workspace: boolean;
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
    recursive = false,
    maxDepth = 2,
    showHidden = false,
    ignoreCommonDirs = true,
  } = options;

  const targetDirPath = options.dirPath || options.path || ".";

  let resolution;
  try {
    resolution = resolvePathWithWorkspace(workspaceRoot, targetDirPath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      action: `list_directory "${targetDirPath}"`,
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

  const resolvedDir = resolution.resolvedPath;
  const withinWorkspace = resolution.withinWorkspace;

  let stat;
  try {
    stat = await fs.stat(resolvedDir);
  } catch (err: any) {
    return {
      success: false,
      action: `list_directory "${targetDirPath}"`,
      text: `Directory "${targetDirPath}" (resolved: "${resolvedDir}") does not exist: ${err.message}`,
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
      action: `list_directory "${targetDirPath}"`,
      text: `"${targetDirPath}" is a file, not a directory. Use read_file instead.`,
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

      // Compute relativePath: if target is within workspace, relative to workspace root;
      // otherwise, relative to the target resolvedDir.
      let relPath: string;
      if (withinWorkspace) {
        relPath = path.relative(workspaceRoot, fullItemPath).replace(/\\/g, "/");
      } else {
        relPath = path.relative(resolvedDir, fullItemPath).replace(/\\/g, "/") || name;
      }

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
        relativePath: relPath,
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

  const warningNote = resolution.warning ? `\nNotice: ${resolution.warning}` : "";
  const header = `Directory: ${targetDirPath} (${entries.length} items: ${directoryCount} directories, ${fileCount} files)${warningNote}`;
  const text = `${header}\n${lines.slice(0, 300).join("\n")}${
    entries.length > 300 ? `\n... and ${entries.length - 300} more items` : ""
  }`;

  return {
    success: true,
    action: `list_directory "${targetDirPath}"`,
    text,
    verification: {
      performed: true,
      passed: true,
      method: "fs_readdir_scanned",
      details: {
        totalCount: entries.length,
        fileCount,
        directoryCount,
        requested_path: targetDirPath,
        resolved_path: resolvedDir,
        within_workspace: withinWorkspace,
      },
    },
    data: {
      directory: targetDirPath,
      requested_path: targetDirPath,
      resolved_path: resolvedDir,
      within_workspace: withinWorkspace,
      entries,
      totalCount: entries.length,
      fileCount,
      directoryCount,
    },
    durationMs: Date.now() - startTime,
  };
}
