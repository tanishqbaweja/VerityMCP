import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../security/roots.js";
import { calculateSha256 } from "../verification/index.js";
import type { StandardToolResponse } from "../types/index.js";

export interface FileMetadataOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  filePath: string;
}

export interface FileMetadataData {
  filePath: string;
  exists: boolean;
  type: "file" | "directory" | "symlink" | "other" | "none";
  sizeBytes?: number;
  sha256?: string;
  createdAt?: string;
  modifiedAt?: string;
  lineCount?: number;
  isBinary?: boolean;
}

export async function executeFileMetadata(
  options: FileMetadataOptions
): Promise<StandardToolResponse<FileMetadataData>> {
  const startTime = Date.now();
  const { workspaceRoot, allowedRoots = [], filePath } = options;

  let resolvedPath: string;
  try {
    resolvedPath = resolveWorkspacePath(workspaceRoot, filePath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      action: `file_metadata "${filePath}"`,
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
    stat = await fs.stat(resolvedPath);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return {
        success: true,
        action: `file_metadata "${filePath}"`,
        text: `File "${filePath}" does not exist.`,
        verification: {
          performed: true,
          passed: true,
          method: "fs_stat_not_found",
          details: { exists: false },
        },
        data: {
          filePath,
          exists: false,
          type: "none",
        },
        durationMs: Date.now() - startTime,
      };
    }
    return {
      success: false,
      action: `file_metadata "${filePath}"`,
      text: `Failed to inspect "${filePath}": ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "fs_stat_error",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  const isDir = stat.isDirectory();
  const isFile = stat.isFile();
  const type: FileMetadataData["type"] = isDir ? "directory" : isFile ? "file" : "other";

  let sha256: string | undefined;
  let isBinary: boolean | undefined;
  let lineCount: number | undefined;

  if (isFile) {
    try {
      const buffer = await fs.readFile(resolvedPath);
      sha256 = calculateSha256(buffer);
      const text = buffer.toString("utf-8");
      isBinary = text.includes("\0");
      if (!isBinary) {
        lineCount = text.split(/\r?\n/).length;
      }
    } catch {}
  }

  const data: FileMetadataData = {
    filePath,
    exists: true,
    type,
    sizeBytes: stat.size,
    sha256,
    createdAt: stat.birthtime.toISOString(),
    modifiedAt: stat.mtime.toISOString(),
    lineCount,
    isBinary,
  };

  const lines = [
    `Path: ${filePath}`,
    `Type: ${type}`,
    `Size: ${stat.size} bytes`,
    `Modified: ${stat.mtime.toISOString()}`,
  ];
  if (sha256) lines.push(`SHA-256: ${sha256}`);
  if (lineCount !== undefined) lines.push(`Lines: ${lineCount}`);
  if (isBinary !== undefined) lines.push(`Binary: ${isBinary ? "Yes" : "No"}`);

  return {
    success: true,
    action: `file_metadata "${filePath}"`,
    text: lines.join("\n"),
    verification: {
      performed: true,
      passed: true,
      method: "fs_stat_full",
      details: { ...data },
    },
    data,
    durationMs: Date.now() - startTime,
  };
}
