import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../security/roots.js";
import { verifyFileContent } from "../verification/index.js";
import type { StandardToolResponse } from "../types/index.js";

export interface WriteFileOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  filePath: string;
  content: string;
  createDirectories?: boolean;
  overwrite?: boolean;
}

export interface WriteFileData {
  filePath: string;
  bytesWritten: number;
  sha256: string;
  createdDirectories: boolean;
}

export async function executeWriteFile(
  options: WriteFileOptions
): Promise<StandardToolResponse<WriteFileData>> {
  const startTime = Date.now();
  const {
    workspaceRoot,
    allowedRoots = [],
    filePath,
    content,
    createDirectories = true,
    overwrite = true,
  } = options;

  let resolvedPath: string;
  try {
    resolvedPath = resolveWorkspacePath(workspaceRoot, filePath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      action: `write_file "${filePath}"`,
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

  // Check if file already exists
  let exists = false;
  try {
    const stat = await fs.stat(resolvedPath);
    exists = true;
    if (stat.isDirectory()) {
      return {
        success: false,
        action: `write_file "${filePath}"`,
        text: `Target path "${filePath}" is an existing directory. Cannot overwrite directory with file.`,
        verification: {
          performed: true,
          passed: false,
          method: "fs_stat_check",
          error: "Target is a directory",
        },
        durationMs: Date.now() - startTime,
      };
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      return {
        success: false,
        action: `write_file "${filePath}"`,
        text: `Failed to inspect target file path: ${err.message}`,
        verification: {
          performed: true,
          passed: false,
          method: "fs_stat",
          error: err.message,
        },
        durationMs: Date.now() - startTime,
      };
    }
  }

  if (exists && !overwrite) {
    return {
      success: false,
      action: `write_file "${filePath}"`,
      text: `File "${filePath}" already exists and overwrite is set to false.`,
      verification: {
        performed: true,
        passed: false,
        method: "overwrite_check",
        error: "File exists and overwrite=false",
      },
      durationMs: Date.now() - startTime,
    };
  }

  // Create parent directories if requested
  let createdDirs = false;
  const parentDir = path.dirname(resolvedPath);
  try {
    if (createDirectories) {
      await fs.mkdir(parentDir, { recursive: true });
      createdDirs = true;
    }
  } catch (err: any) {
    return {
      success: false,
      action: `write_file "${filePath}"`,
      text: `Failed to create parent directories for "${filePath}": ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "fs_mkdir",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  // Write content
  try {
    await fs.writeFile(resolvedPath, content, "utf-8");
  } catch (err: any) {
    return {
      success: false,
      action: `write_file "${filePath}"`,
      text: `Failed to write file "${filePath}": ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "fs_writeFile",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  // MANDATORY POST-WRITE VERIFICATION
  const verification = await verifyFileContent(resolvedPath, content);

  if (!verification.passed) {
    return {
      success: false,
      action: `write_file "${filePath}"`,
      text: `CRITICAL: Write to "${filePath}" failed verification! Disk state does not match written buffer.`,
      verification,
      durationMs: Date.now() - startTime,
    };
  }

  const bytesWritten = Buffer.byteLength(content, "utf-8");
  const sha256 = (verification.details?.hash as string) || "";

  return {
    success: true,
    action: `write_file "${filePath}"`,
    text: `Successfully wrote ${bytesWritten} bytes to "${filePath}" (SHA-256: ${sha256.slice(0, 16)}...). Verification passed.`,
    verification,
    data: {
      filePath,
      bytesWritten,
      sha256,
      createdDirectories: createdDirs,
    },
    durationMs: Date.now() - startTime,
  };
}
