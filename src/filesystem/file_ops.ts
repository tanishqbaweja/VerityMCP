import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../security/roots.js";
import {
  verifyFileExistence,
  verifyFileRelocation,
  verifyFileContent,
} from "../verification/index.js";
import type { StandardToolResponse } from "../types/index.js";

export interface DeleteFileOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  filePath: string;
  recursive?: boolean;
}

export async function executeDeleteFile(
  options: DeleteFileOptions
): Promise<StandardToolResponse<{ filePath: string }>> {
  const startTime = Date.now();
  const { workspaceRoot, allowedRoots = [], filePath, recursive = false } = options;

  let resolvedPath: string;
  try {
    resolvedPath = resolveWorkspacePath(workspaceRoot, filePath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      action: `delete_file "${filePath}"`,
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
        success: false,
        action: `delete_file "${filePath}"`,
        text: `Cannot delete "${filePath}": File does not exist.`,
        verification: {
          performed: true,
          passed: false,
          method: "fs_stat_exists",
          error: "File not found",
        },
        durationMs: Date.now() - startTime,
      };
    }
    return {
      success: false,
      action: `delete_file "${filePath}"`,
      text: `Error inspecting path "${filePath}": ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "fs_stat",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  try {
    if (stat.isDirectory()) {
      if (!recursive) {
        return {
          success: false,
          action: `delete_file "${filePath}"`,
          text: `"${filePath}" is a directory. Set recursive: true to delete directory trees.`,
          verification: {
            performed: true,
            passed: false,
            method: "directory_guard",
            error: "Path is directory, recursive not specified",
          },
          durationMs: Date.now() - startTime,
        };
      }
      await fs.rm(resolvedPath, { recursive: true, force: true });
    } else {
      await fs.unlink(resolvedPath);
    }
  } catch (err: any) {
    return {
      success: false,
      action: `delete_file "${filePath}"`,
      text: `Failed to remove "${filePath}": ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "fs_remove",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  // MANDATORY POST-DELETE VERIFICATION
  const verification = await verifyFileExistence(resolvedPath, false);

  if (!verification.passed) {
    return {
      success: false,
      action: `delete_file "${filePath}"`,
      text: `CRITICAL: Delete operation completed but file "${filePath}" still exists on disk!`,
      verification,
      durationMs: Date.now() - startTime,
    };
  }

  return {
    success: true,
    action: `delete_file "${filePath}"`,
    text: `Successfully deleted "${filePath}". Verification confirmed file is unlinked.`,
    verification,
    data: { filePath },
    durationMs: Date.now() - startTime,
  };
}

export interface MoveFileOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  sourcePath: string;
  destinationPath: string;
  overwrite?: boolean;
}

export async function executeMoveFile(
  options: MoveFileOptions
): Promise<StandardToolResponse<{ sourcePath: string; destinationPath: string }>> {
  const startTime = Date.now();
  const { workspaceRoot, allowedRoots = [], sourcePath, destinationPath, overwrite = false } = options;

  let resolvedSource: string;
  let resolvedDest: string;

  try {
    resolvedSource = resolveWorkspacePath(workspaceRoot, sourcePath, allowedRoots);
    resolvedDest = resolveWorkspacePath(workspaceRoot, destinationPath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      action: `move_file "${sourcePath}" -> "${destinationPath}"`,
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

  try {
    await fs.stat(resolvedSource);
  } catch (err: any) {
    return {
      success: false,
      action: `move_file "${sourcePath}" -> "${destinationPath}"`,
      text: `Source path "${sourcePath}" does not exist: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "source_stat_check",
        error: "Source not found",
      },
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const destStat = await fs.stat(resolvedDest);
    if (!overwrite) {
      return {
        success: false,
        action: `move_file "${sourcePath}" -> "${destinationPath}"`,
        text: `Destination "${destinationPath}" already exists and overwrite is false.`,
        verification: {
          performed: true,
          passed: false,
          method: "dest_overwrite_guard",
          error: "Destination exists",
        },
        durationMs: Date.now() - startTime,
      };
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      return {
        success: false,
        action: `move_file "${sourcePath}" -> "${destinationPath}"`,
        text: `Failed to inspect destination path: ${err.message}`,
        verification: {
          performed: true,
          passed: false,
          method: "dest_stat",
          error: err.message,
        },
        durationMs: Date.now() - startTime,
      };
    }
  }

  // Ensure destination directory exists
  try {
    await fs.mkdir(path.dirname(resolvedDest), { recursive: true });
    await fs.rename(resolvedSource, resolvedDest);
  } catch (err: any) {
    return {
      success: false,
      action: `move_file "${sourcePath}" -> "${destinationPath}"`,
      text: `Failed to rename/move file: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "fs_rename",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  // MANDATORY POST-RELOCATION VERIFICATION
  const verification = await verifyFileRelocation(resolvedSource, resolvedDest);

  if (!verification.passed) {
    return {
      success: false,
      action: `move_file "${sourcePath}" -> "${destinationPath}"`,
      text: `Move failed verification: ${verification.error}`,
      verification,
      durationMs: Date.now() - startTime,
    };
  }

  return {
    success: true,
    action: `move_file "${sourcePath}" -> "${destinationPath}"`,
    text: `Successfully moved "${sourcePath}" to "${destinationPath}". Relocation verified.`,
    verification,
    data: { sourcePath, destinationPath },
    durationMs: Date.now() - startTime,
  };
}

export interface CopyFileOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  sourcePath: string;
  destinationPath: string;
  overwrite?: boolean;
}

export async function executeCopyFile(
  options: CopyFileOptions
): Promise<StandardToolResponse<{ sourcePath: string; destinationPath: string; bytesCopied: number }>> {
  const startTime = Date.now();
  const { workspaceRoot, allowedRoots = [], sourcePath, destinationPath, overwrite = true } = options;

  let resolvedSource: string;
  let resolvedDest: string;

  try {
    resolvedSource = resolveWorkspacePath(workspaceRoot, sourcePath, allowedRoots);
    resolvedDest = resolveWorkspacePath(workspaceRoot, destinationPath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      action: `copy_file "${sourcePath}" -> "${destinationPath}"`,
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

  let srcContent: string;
  try {
    srcContent = await fs.readFile(resolvedSource, "utf-8");
  } catch (err: any) {
    return {
      success: false,
      action: `copy_file "${sourcePath}" -> "${destinationPath}"`,
      text: `Cannot read source file "${sourcePath}": ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "read_source",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  try {
    await fs.mkdir(path.dirname(resolvedDest), { recursive: true });
    await fs.copyFile(
      resolvedSource,
      resolvedDest,
      overwrite ? 0 : fs.constants.COPYFILE_EXCL
    );
  } catch (err: any) {
    return {
      success: false,
      action: `copy_file "${sourcePath}" -> "${destinationPath}"`,
      text: `Failed to copy file: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "fs_copyFile",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  // MANDATORY POST-COPY VERIFICATION
  const verification = await verifyFileContent(resolvedDest, srcContent);

  if (!verification.passed) {
    return {
      success: false,
      action: `copy_file "${sourcePath}" -> "${destinationPath}"`,
      text: `Copy failed verification: destination content does not match source. ${verification.error}`,
      verification,
      durationMs: Date.now() - startTime,
    };
  }

  const bytesCopied = Buffer.byteLength(srcContent, "utf-8");

  return {
    success: true,
    action: `copy_file "${sourcePath}" -> "${destinationPath}"`,
    text: `Successfully copied ${bytesCopied} bytes from "${sourcePath}" to "${destinationPath}". Verification passed.`,
    verification,
    data: { sourcePath, destinationPath, bytesCopied },
    durationMs: Date.now() - startTime,
  };
}
