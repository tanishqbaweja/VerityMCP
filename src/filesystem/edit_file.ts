import fs from "node:fs/promises";
import crypto from "node:crypto";
import * as diff from "diff";
import { resolveWorkspacePath } from "../security/roots.js";
import { verifyFileContent } from "../verification/index.js";
import type { StandardToolResponse } from "../types/index.js";

export interface EditFileOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  expectedSha256?: string;
}

export interface EditFileData {
  filePath: string;
  path?: string;
  operation?: string;
  before_sha256?: string;
  after_sha256?: string;
  additions?: number;
  removals?: number;
  verified?: boolean;
  replacements: number;
  diffPatch: string;
  oldSizeBytes: number;
  newSizeBytes: number;
  sha256: string;
}

export async function executeEditFile(
  options: EditFileOptions
): Promise<StandardToolResponse<EditFileData>> {
  const startTime = Date.now();
  const {
    workspaceRoot,
    allowedRoots = [],
    filePath,
    oldString,
    newString,
    replaceAll = false,
  } = options;

  let resolvedPath: string;
  try {
    resolvedPath = resolveWorkspacePath(workspaceRoot, filePath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      action: `edit_file "${filePath}"`,
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

  if (oldString === newString) {
    return {
      success: false,
      action: `edit_file "${filePath}"`,
      text: `old_string and new_string are identical. No edits to perform.`,
      verification: {
        performed: true,
        passed: false,
        method: "parameters_equality_check",
        error: "old_string === new_string",
      },
      durationMs: Date.now() - startTime,
    };
  }

  let originalContent: string;
  try {
    originalContent = await fs.readFile(resolvedPath, "utf-8");
  } catch (err: any) {
    return {
      success: false,
      error_code: "FILE_NOT_FOUND",
      action: `edit_file "${filePath}"`,
      text: `Failed to read target file "${filePath}": ${err.message}`,
      summary: `Target file not readable: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "fs_readFile",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  if (options.expectedSha256) {
    const currentHash = crypto.createHash("sha256").update(Buffer.from(originalContent)).digest("hex");
    if (currentHash !== options.expectedSha256) {
      return {
        success: false,
        error_code: "FILE_CHANGED_SINCE_READ",
        action: `edit_file "${filePath}"`,
        text: `Precondition failed: file "${filePath}" has changed since last read. Expected SHA-256 "${options.expectedSha256}", found "${currentHash}".`,
        summary: `Concurrent edit conflict: file changed since last read`,
        verification: {
          performed: true,
          passed: false,
          method: "expected_sha256_precondition_check",
          error: `Hash mismatch: expected ${options.expectedSha256}, actual ${currentHash}`,
          execution: { status: "failed", method: "expected_sha256_precondition_check" },
          state: { status: "not_performed" },
        },
        durationMs: Date.now() - startTime,
      };
    }
  }

  let targetContent = originalContent;
  let searchString = oldString;

  // Handle CRLF vs LF line endings if exact match fails
  if (!targetContent.includes(searchString)) {
    const normContent = targetContent.replace(/\r\n/g, "\n");
    const normOld = searchString.replace(/\r\n/g, "\n");
    if (normContent.includes(normOld)) {
      targetContent = normContent;
      searchString = normOld;
    } else {
      return {
        success: false,
        action: `edit_file "${filePath}"`,
        text: `old_string not found in "${filePath}". Please verify indentation and read latest file content before editing.`,
        verification: {
          performed: true,
          passed: false,
          method: "substring_search",
          error: "old_string not found in file content",
        },
        durationMs: Date.now() - startTime,
      };
    }
  }

  const occurrences = targetContent.split(searchString).length - 1;

  if (occurrences > 1 && !replaceAll) {
    return {
      success: false,
      action: `edit_file "${filePath}"`,
      text: `old_string occurs ${occurrences} times in "${filePath}". Provide more surrounding context lines to uniquely identify the location, or specify replaceAll: true.`,
      verification: {
        performed: true,
        passed: false,
        method: "occurrence_cardinality_check",
        error: `Found ${occurrences} occurrences, expected 1`,
      },
      durationMs: Date.now() - startTime,
    };
  }

  let newContent: string;
  let replacements = 0;

  if (replaceAll) {
    newContent = targetContent.replaceAll(searchString, newString);
    replacements = occurrences;
  } else {
    newContent = targetContent.replace(searchString, newString);
    replacements = 1;
  }

  // Generate unified diff for model verification
  const diffPatch = diff.createPatch(filePath, targetContent, newContent, "original", "modified");

  // Write modification to disk
  try {
    await fs.writeFile(resolvedPath, newContent, "utf-8");
  } catch (err: any) {
    return {
      success: false,
      action: `edit_file "${filePath}"`,
      text: `Failed to write edited content to "${filePath}": ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "fs_writeFile",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  // MANDATORY POST-EDIT VERIFICATION
  const verification = await verifyFileContent(resolvedPath, newContent);

  if (!verification.passed) {
    // Attempt rollback to original content
    try {
      await fs.writeFile(resolvedPath, originalContent, "utf-8");
    } catch {}

    return {
      success: false,
      action: `edit_file "${filePath}"`,
      text: `CRITICAL: Edit to "${filePath}" failed readback verification! Rollback attempted. ${verification.error}`,
      verification,
      durationMs: Date.now() - startTime,
    };
  }

  const sha256 = (verification.details?.hash as string) || "";
  const beforeSha256 = crypto.createHash("sha256").update(Buffer.from(originalContent)).digest("hex");
  const oldSizeBytes = Buffer.byteLength(originalContent, "utf-8");
  const newSizeBytes = Buffer.byteLength(newContent, "utf-8");

  const diffLines = diffPatch.split("\n");
  const additions = diffLines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const removals = diffLines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

  return {
    success: true,
    action: `edit_file "${filePath}" (${replacements} replacement${replacements > 1 ? "s" : ""})`,
    text: `Successfully edited "${filePath}" (${replacements} replacement${replacements > 1 ? "s" : ""}).\n\n${diffPatch}`,
    verification,
    data: {
      path: filePath,
      filePath,
      operation: "update",
      before_sha256: beforeSha256,
      after_sha256: sha256,
      additions,
      removals,
      verified: true,
      replacements,
      diffPatch,
      oldSizeBytes,
      newSizeBytes,
      sha256,
    },
    durationMs: Date.now() - startTime,
  };
}
