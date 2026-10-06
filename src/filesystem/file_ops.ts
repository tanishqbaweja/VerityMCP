import fs from "node:fs/promises";
import path from "node:path";
import { resolvePathWithWorkspace } from "../security/roots.js";
import { activityStream } from "../observability/activity_stream.js";
import {
  verifyFileExistence,
  verifyFileRelocation,
  verifyFileContent,
} from "../verification/index.js";
import { processManager } from "../shell/process_manager.js";
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

  let pathRes;
  try {
    pathRes = resolvePathWithWorkspace(workspaceRoot, filePath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      error_code: "SECURITY_VIOLATION",
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

  const resolvedPath = pathRes.resolvedPath;

  activityStream.emit({
    type: "action_started",
    title: `Deleting ${path.basename(filePath)}`,
    purpose: "Unlink target path and verify absence from disk",
    tool: "delete_file",
    target: { path: resolvedPath },
    details: { recursive, withinWorkspace: pathRes.withinWorkspace },
  });

  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return {
        success: false,
        error_code: "FILE_NOT_FOUND",
        action: `delete_file "${filePath}"`,
        display_title: `Deleting ${path.basename(filePath)}`,
        display_status: "failed",
        within_workspace: pathRes.withinWorkspace,
        workspace_root: pathRes.workspaceRoot,
        resolved_path: resolvedPath,
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
      error_code: "COMMAND_FAILED",
      action: `delete_file "${filePath}"`,
      display_title: `Deleting ${path.basename(filePath)}`,
      display_status: "failed",
      within_workspace: pathRes.withinWorkspace,
      workspace_root: pathRes.workspaceRoot,
      resolved_path: resolvedPath,
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
          error_code: "INVALID_ARGUMENT",
          action: `delete_file "${filePath}"`,
          display_title: `Deleting ${path.basename(filePath)}`,
          display_status: "failed",
          within_workspace: pathRes.withinWorkspace,
          workspace_root: pathRes.workspaceRoot,
          resolved_path: resolvedPath,
          text: `"${filePath}" is a directory. Set recursive: true to delete directory trees.`,
          verification: {
            performed: true,
            passed: false,
            method: "is_directory_check",
            error: "Path is a directory, recursive flag not set",
          },
          durationMs: Date.now() - startTime,
        };
      }
      await fs.rm(resolvedPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } else {
      await fs.unlink(resolvedPath);
    }
  } catch (err: any) {
    const isBusy = err.code === "EBUSY" || err.code === "EPERM" || String(err.message).includes("EBUSY");
    let errorCode = "COMMAND_FAILED";
    let blockingSessions: string[] = [];

    if (isBusy) {
      const runningSessions = processManager.listSessions();
      blockingSessions = runningSessions
        .filter((s) => {
          const sCwd = (s as any).cwd;
          if (!sCwd) return false;
          const normCwd = path.resolve(sCwd).toLowerCase();
          const normTarget = path.resolve(resolvedPath).toLowerCase();
          return normCwd === normTarget || normCwd.startsWith(normTarget.endsWith(path.sep) ? normTarget : normTarget + path.sep);
        })
        .map((s) => s.id);

      if (blockingSessions.length > 0) {
        errorCode = "WORKSPACE_IN_USE";
      } else {
        errorCode = "RESOURCE_BUSY";
      }
    }

    const errorDetails = blockingSessions.length > 0 ? { blocking_sessions: blockingSessions, error: err.message } : { error: err.message };

    return {
      success: false,
      error_code: errorCode,
      action: `delete_file "${filePath}"`,
      display_title: `Deleting ${path.basename(filePath)}`,
      display_status: "failed",
      within_workspace: pathRes.withinWorkspace,
      workspace_root: pathRes.workspaceRoot,
      resolved_path: resolvedPath,
      text: errorCode === "WORKSPACE_IN_USE"
        ? `Cannot delete "${filePath}": Directory is currently in use by active process session(s): ${blockingSessions.join(", ")}.`
        : errorCode === "RESOURCE_BUSY"
        ? `Cannot delete "${filePath}": Resource is locked or busy (EBUSY / sharing violation).`
        : `Failed to delete "${filePath}": ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "fs_unlink_or_rm",
        error: err.message,
        details: errorDetails,
      },
      durationMs: Date.now() - startTime,
    };
  }

  // MANDATORY POST-DELETION VERIFICATION
  const verifyRes = await verifyFileExistence(resolvedPath, false);

  if (!verifyRes.passed) {
    return {
      success: false,
      error_code: "COMMAND_FAILED",
      action: `delete_file "${filePath}"`,
      display_title: `Deleting ${path.basename(filePath)}`,
      display_status: "failed",
      within_workspace: pathRes.withinWorkspace,
      workspace_root: pathRes.workspaceRoot,
      resolved_path: resolvedPath,
      text: `CRITICAL: Deletion of "${filePath}" failed verification! Path still exists on disk.`,
      verification: verifyRes,
      durationMs: Date.now() - startTime,
    };
  }

  activityStream.emit({
    type: "action_completed",
    title: `Deleted ${path.basename(filePath)}`,
    tool: "delete_file",
    target: { path: resolvedPath },
  });

  return {
    success: true,
    action: `delete_file "${filePath}"`,
    display_title: `Deleting ${path.basename(filePath)}`,
    display_status: "verified",
    within_workspace: pathRes.withinWorkspace,
    workspace_root: pathRes.workspaceRoot,
    resolved_path: resolvedPath,
    warning: pathRes.warning,
    text: `Successfully deleted "${filePath}". Verification confirmed file is unlinked.`,
    verification: verifyRes,
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

  let srcRes;
  let dstRes;
  try {
    srcRes = resolvePathWithWorkspace(workspaceRoot, sourcePath, allowedRoots);
    dstRes = resolvePathWithWorkspace(workspaceRoot, destinationPath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      error_code: "SECURITY_VIOLATION",
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

  const resolvedSource = srcRes.resolvedPath;
  const resolvedDest = dstRes.resolvedPath;

  activityStream.emit({
    type: "action_started",
    title: `Moving ${path.basename(sourcePath)} -> ${path.basename(destinationPath)}`,
    tool: "move_file",
    target: { source: resolvedSource, destination: resolvedDest },
  });

  try {
    await fs.stat(resolvedSource);
  } catch (err: any) {
    return {
      success: false,
      error_code: "FILE_NOT_FOUND",
      action: `move_file "${sourcePath}" -> "${destinationPath}"`,
      display_title: `Moving ${path.basename(sourcePath)}`,
      display_status: "failed",
      within_workspace: srcRes.withinWorkspace && dstRes.withinWorkspace,
      workspace_root: srcRes.workspaceRoot,
      resolved_path: resolvedDest,
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
    await fs.stat(resolvedDest);
    if (!overwrite) {
      return {
        success: false,
        error_code: "INVALID_ARGUMENT",
        action: `move_file "${sourcePath}" -> "${destinationPath}"`,
        display_title: `Moving ${path.basename(sourcePath)}`,
        display_status: "failed",
        within_workspace: srcRes.withinWorkspace && dstRes.withinWorkspace,
        workspace_root: srcRes.workspaceRoot,
        resolved_path: resolvedDest,
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
        error_code: "COMMAND_FAILED",
        action: `move_file "${sourcePath}" -> "${destinationPath}"`,
        display_title: `Moving ${path.basename(sourcePath)}`,
        display_status: "failed",
        within_workspace: srcRes.withinWorkspace && dstRes.withinWorkspace,
        workspace_root: srcRes.workspaceRoot,
        resolved_path: resolvedDest,
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

  try {
    await fs.mkdir(path.dirname(resolvedDest), { recursive: true });
    await fs.rename(resolvedSource, resolvedDest);
  } catch (err: any) {
    return {
      success: false,
      error_code: "COMMAND_FAILED",
      action: `move_file "${sourcePath}" -> "${destinationPath}"`,
      display_title: `Moving ${path.basename(sourcePath)}`,
      display_status: "failed",
      within_workspace: srcRes.withinWorkspace && dstRes.withinWorkspace,
      workspace_root: srcRes.workspaceRoot,
      resolved_path: resolvedDest,
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
      error_code: "COMMAND_FAILED",
      action: `move_file "${sourcePath}" -> "${destinationPath}"`,
      display_title: `Moving ${path.basename(sourcePath)}`,
      display_status: "failed",
      within_workspace: srcRes.withinWorkspace && dstRes.withinWorkspace,
      workspace_root: srcRes.workspaceRoot,
      resolved_path: resolvedDest,
      text: `Move failed verification: ${verification.error}`,
      verification,
      durationMs: Date.now() - startTime,
    };
  }

  activityStream.emit({
    type: "action_completed",
    title: `Moved ${path.basename(sourcePath)} to ${path.basename(destinationPath)}`,
    tool: "move_file",
    target: { destination: resolvedDest },
  });

  return {
    success: true,
    action: `move_file "${sourcePath}" -> "${destinationPath}"`,
    display_title: `Moving ${path.basename(sourcePath)}`,
    display_status: "verified",
    within_workspace: srcRes.withinWorkspace && dstRes.withinWorkspace,
    workspace_root: srcRes.workspaceRoot,
    resolved_path: resolvedDest,
    warning: srcRes.warning || dstRes.warning,
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

  let srcRes;
  let dstRes;
  try {
    srcRes = resolvePathWithWorkspace(workspaceRoot, sourcePath, allowedRoots);
    dstRes = resolvePathWithWorkspace(workspaceRoot, destinationPath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      error_code: "SECURITY_VIOLATION",
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

  const resolvedSource = srcRes.resolvedPath;
  const resolvedDest = dstRes.resolvedPath;

  activityStream.emit({
    type: "action_started",
    title: `Copying ${path.basename(sourcePath)} -> ${path.basename(destinationPath)}`,
    tool: "copy_file",
    target: { source: resolvedSource, destination: resolvedDest },
  });

  let srcContent: string;
  try {
    srcContent = await fs.readFile(resolvedSource, "utf-8");
  } catch (err: any) {
    return {
      success: false,
      error_code: "FILE_NOT_FOUND",
      action: `copy_file "${sourcePath}" -> "${destinationPath}"`,
      display_title: `Copying ${path.basename(sourcePath)}`,
      display_status: "failed",
      within_workspace: srcRes.withinWorkspace && dstRes.withinWorkspace,
      workspace_root: srcRes.workspaceRoot,
      resolved_path: resolvedDest,
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
      error_code: "COMMAND_FAILED",
      action: `copy_file "${sourcePath}" -> "${destinationPath}"`,
      display_title: `Copying ${path.basename(sourcePath)}`,
      display_status: "failed",
      within_workspace: srcRes.withinWorkspace && dstRes.withinWorkspace,
      workspace_root: srcRes.workspaceRoot,
      resolved_path: resolvedDest,
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
      error_code: "COMMAND_FAILED",
      action: `copy_file "${sourcePath}" -> "${destinationPath}"`,
      display_title: `Copying ${path.basename(sourcePath)}`,
      display_status: "failed",
      within_workspace: srcRes.withinWorkspace && dstRes.withinWorkspace,
      workspace_root: srcRes.workspaceRoot,
      resolved_path: resolvedDest,
      text: `Copy failed verification: destination content does not match source. ${verification.error}`,
      verification,
      durationMs: Date.now() - startTime,
    };
  }

  const bytesCopied = Buffer.byteLength(srcContent, "utf-8");

  activityStream.emit({
    type: "action_completed",
    title: `Copied ${bytesCopied} bytes to ${path.basename(destinationPath)}`,
    tool: "copy_file",
    target: { destination: resolvedDest },
  });

  return {
    success: true,
    action: `copy_file "${sourcePath}" -> "${destinationPath}"`,
    display_title: `Copying ${path.basename(sourcePath)}`,
    display_status: "verified",
    within_workspace: srcRes.withinWorkspace && dstRes.withinWorkspace,
    workspace_root: srcRes.workspaceRoot,
    resolved_path: resolvedDest,
    warning: srcRes.warning || dstRes.warning,
    text: `Successfully copied ${bytesCopied} bytes from "${sourcePath}" to "${destinationPath}". Verification passed.`,
    verification,
    data: { sourcePath, destinationPath, bytesCopied },
    durationMs: Date.now() - startTime,
  };
}
