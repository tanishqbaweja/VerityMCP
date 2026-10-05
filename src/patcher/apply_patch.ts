import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as diff from "diff";
import { resolveWorkspacePath } from "../security/roots.js";
import { activityStream } from "../observability/activity_stream.js";
import {
  verifyFileContent,
  verifyFileExistence,
  verifyFileRelocation,
} from "../verification/index.js";
import type { StandardToolResponse, VerificationResult } from "../types/index.js";

export interface HunkLine {
  kind: "context" | "add" | "remove";
  text: string;
}

export interface Hunk {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  changeContext?: string;
  endOfFile?: boolean;
  lines: HunkLine[];
}

export interface FilePatch {
  type: "add" | "delete" | "update" | "move";
  filePath: string;
  newFilePath?: string;
  addContent?: string;
  hunks: Hunk[];
}

export interface ApplyPatchOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  patch: string;
  expectedSha256Map?: Record<string, string>;
}

export interface ApplyPatchData {
  filesModified: string[];
  filesAdded: string[];
  filesDeleted: string[];
  filesMoved: string[];
  diffSummary: string;
  verifications: Record<string, VerificationResult>;
}

/**
 * Parses Codex patch format (`*** Begin Patch ... *** End Patch`) or standard unified diffs.
 */
export function parsePatch(rawPatch: string): FilePatch[] {
  const patches: FilePatch[] = [];
  const rawLines = rawPatch.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  // Skip leading markdown fences or preamble
  while (i < rawLines.length) {
    const trimmed = rawLines[i].trim();
    if (trimmed === "*** Begin Patch" || trimmed.startsWith("--- ") || trimmed.startsWith("diff --git")) {
      break;
    }
    i++;
  }

  // Handle Codex patch format
  if (i < rawLines.length && rawLines[i].trim() === "*** Begin Patch") {
    i++; // consume *** Begin Patch
    let currentPatch: FilePatch | null = null;
    let currentHunk: Hunk | null = null;

    const finalizeHunk = () => {
      if (currentHunk && currentPatch) {
        if (currentHunk.lines.length > 0) {
          currentPatch.hunks.push(currentHunk);
        }
        currentHunk = null;
      }
    };

    const finalizePatch = () => {
      finalizeHunk();
      if (currentPatch) {
        patches.push(currentPatch);
        currentPatch = null;
      }
    };

    while (i < rawLines.length) {
      const line = rawLines[i];
      const trimmed = line.trim();

      if (trimmed === "*** End Patch") {
        finalizePatch();
        i++;
        break;
      }

      // Add File
      const addMatch = line.match(/^\*\*\*\s+Add File:\s*(.+)$/i);
      if (addMatch) {
        finalizePatch();
        const filePath = addMatch[1].trim();
        i++;
        const contentLines: string[] = [];
        while (i < rawLines.length) {
          const next = rawLines[i];
          if (next.startsWith("*** ") || next.startsWith("--- ") || next.startsWith("diff --git")) {
            break;
          }
          if (next.startsWith("+")) {
            contentLines.push(next.slice(1));
          } else {
            contentLines.push(next);
          }
          i++;
        }
        patches.push({
          type: "add",
          filePath,
          addContent: contentLines.join("\n"),
          hunks: [],
        });
        continue;
      }

      // Delete File
      const delMatch = line.match(/^\*\*\*\s+Delete File:\s*(.+)$/i);
      if (delMatch) {
        finalizePatch();
        patches.push({
          type: "delete",
          filePath: delMatch[1].trim(),
          hunks: [],
        });
        i++;
        continue;
      }

      // Move File
      const moveMatch = line.match(/^\*\*\*\s+Move File:\s*(.+)\s*->\s*(.+)$/i);
      if (moveMatch) {
        finalizePatch();
        patches.push({
          type: "move",
          filePath: moveMatch[1].trim(),
          newFilePath: moveMatch[2].trim(),
          hunks: [],
        });
        i++;
        continue;
      }

      // Update File
      const updateMatch = line.match(/^\*\*\*\s+Update File:\s*(.+)$/i);
      if (updateMatch) {
        finalizePatch();
        currentPatch = {
          type: "update",
          filePath: updateMatch[1].trim(),
          hunks: [],
        };
        i++;
        if (i < rawLines.length && rawLines[i].trim().startsWith("*** Move to: ")) {
          currentPatch.newFilePath = rawLines[i].trim().slice("*** Move to: ".length).trim();
          i++;
        }
        continue;
      }

      // Hunk headers
      if (trimmed.startsWith("@@")) {
        finalizeHunk();
        const headerMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);
        if (headerMatch) {
          currentHunk = {
            oldStart: parseInt(headerMatch[1], 10),
            oldLines: headerMatch[2] ? parseInt(headerMatch[2], 10) : 1,
            newStart: parseInt(headerMatch[3], 10),
            newLines: headerMatch[4] ? parseInt(headerMatch[4], 10) : 1,
            changeContext: headerMatch[5]?.trim() || undefined,
            lines: [],
          };
        } else {
          currentHunk = {
            changeContext: trimmed.slice(2).trim() || undefined,
            lines: [],
          };
        }
        i++;
        continue;
      }

      if (trimmed === "*** End of File") {
        if (currentHunk) {
          currentHunk.endOfFile = true;
        }
        i++;
        continue;
      }

      // Hunk content line
      if (currentPatch && currentPatch.type === "update") {
        if (!currentHunk) {
          currentHunk = { lines: [] };
        }
        if (line.startsWith(" ")) {
          currentHunk.lines.push({ kind: "context", text: line.slice(1) });
        } else if (line.startsWith("+")) {
          currentHunk.lines.push({ kind: "add", text: line.slice(1) });
        } else if (line.startsWith("-")) {
          currentHunk.lines.push({ kind: "remove", text: line.slice(1) });
        } else if (trimmed === "") {
          currentHunk.lines.push({ kind: "context", text: "" });
        }
      }

      i++;
    }

    finalizePatch();
    return patches;
  }

  // Handle Unified Diff Format
  let currentPatch: FilePatch | null = null;
  let currentHunk: Hunk | null = null;

  const finalizeHunk = () => {
    if (currentHunk && currentPatch) {
      if (currentHunk.lines.length > 0) {
        currentPatch.hunks.push(currentHunk);
      }
      currentHunk = null;
    }
  };

  const finalizePatch = () => {
    finalizeHunk();
    if (currentPatch) {
      patches.push(currentPatch);
      currentPatch = null;
    }
  };

  while (i < rawLines.length) {
    const line = rawLines[i];

    if (line.startsWith("--- ")) {
      finalizePatch();
      const oldPath = line.replace(/^---\s+([ab]\/)?/, "").trim();
      let newPath = oldPath;
      if (i + 1 < rawLines.length && rawLines[i + 1].startsWith("+++ ")) {
        newPath = rawLines[i + 1].replace(/^\+\+\+\s+([ab]\/)?/, "").trim();
        i++;
      }

      const isDevNull = oldPath === "/dev/null";
      const isNewDevNull = newPath === "/dev/null";

      if (isDevNull) {
        currentPatch = { type: "add", filePath: newPath, hunks: [], addContent: "" };
      } else if (isNewDevNull) {
        currentPatch = { type: "delete", filePath: oldPath, hunks: [] };
      } else {
        currentPatch = { type: "update", filePath: newPath, hunks: [] };
      }
      i++;
      continue;
    }

    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);
    if (hunkMatch) {
      finalizeHunk();
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldLines: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newLines: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
        changeContext: hunkMatch[5]?.trim() || undefined,
        lines: [],
      };
      i++;
      continue;
    }

    if (currentHunk) {
      if (line.startsWith(" ")) {
        currentHunk.lines.push({ kind: "context", text: line.slice(1) });
      } else if (line.startsWith("+")) {
        currentHunk.lines.push({ kind: "add", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ kind: "remove", text: line.slice(1) });
      } else if (line === "") {
        currentHunk.lines.push({ kind: "context", text: "" });
      }
    }

    i++;
  }

  finalizePatch();
  return patches;
}

/**
 * Robust hunk applier with multi-strategy sequence matching.
 */
function applyHunksToContent(originalContent: string, hunks: Hunk[], filePath: string): string {
  if (hunks.length === 0) {
    throw new Error(`Invalid patch for "${filePath}": No diff hunks provided for file update.`);
  }

  const isCRLF = originalContent.includes("\r\n");
  const normalized = originalContent.replace(/\r\n/g, "\n");
  const fileLines = normalized.split("\n");
  const currentLines = [...fileLines];

  let lineOffset = 0;

  for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
    const hunk = hunks[hIdx];
    const oldLines: string[] = [];
    const newLines: string[] = [];

    for (const hl of hunk.lines) {
      if (hl.kind === "context") {
        oldLines.push(hl.text);
        newLines.push(hl.text);
      } else if (hl.kind === "remove") {
        oldLines.push(hl.text);
      } else if (hl.kind === "add") {
        newLines.push(hl.text);
      }
    }

    if (oldLines.length === 0 && newLines.length === 0) {
      continue;
    }

    let matchIndex = -1;

    // Strategy 1: Target line index based on hunk oldStart
    const targetIdx = hunk.oldStart !== undefined ? hunk.oldStart - 1 + lineOffset : -1;

    const checkMatch = (idx: number, tolerant = false): boolean => {
      if (idx < 0 || idx + oldLines.length > currentLines.length) return false;
      for (let j = 0; j < oldLines.length; j++) {
        const cur = currentLines[idx + j];
        const exp = oldLines[j];
        if (tolerant) {
          if (cur.trimEnd() !== exp.trimEnd()) return false;
        } else {
          if (cur !== exp) return false;
        }
      }
      return true;
    };

    if (targetIdx >= 0 && checkMatch(targetIdx, false)) {
      matchIndex = targetIdx;
    } else {
      // Strategy 2: Windowed scan around targetIdx
      const maxWindow = 100;
      if (targetIdx >= 0) {
        for (let delta = 1; delta <= maxWindow; delta++) {
          if (checkMatch(targetIdx - delta, false)) {
            matchIndex = targetIdx - delta;
            break;
          }
          if (checkMatch(targetIdx + delta, false)) {
            matchIndex = targetIdx + delta;
            break;
          }
        }
      }

      // Strategy 3: Full file scan if not found
      if (matchIndex === -1) {
        for (let idx = 0; idx <= currentLines.length - oldLines.length; idx++) {
          if (checkMatch(idx, false)) {
            matchIndex = idx;
            break;
          }
        }
      }

      // Strategy 4: Tolerant whitespace matching
      if (matchIndex === -1) {
        for (let idx = 0; idx <= currentLines.length - oldLines.length; idx++) {
          if (checkMatch(idx, true)) {
            matchIndex = idx;
            break;
          }
        }
      }
    }

    if (matchIndex === -1) {
      const expectedSample = oldLines.slice(0, 5).join("\n");
      throw new Error(
        `Failed to locate hunk #${hIdx + 1} in "${filePath}".\nExpected lines:\n${expectedSample}`
      );
    }

    // Apply the replacement
    currentLines.splice(matchIndex, oldLines.length, ...newLines);
    lineOffset += matchIndex - (targetIdx >= 0 ? targetIdx : matchIndex) + (newLines.length - oldLines.length);
  }

  const result = currentLines.join("\n");
  return isCRLF ? result.replace(/\n/g, "\r\n") : result;
}

interface PlannedOp {
  type: "write" | "delete" | "move";
  displayPath: string;
  targetPath: string;
  sourcePath?: string;
  newContent?: string;
  originalContent?: string;
}

export async function executeApplyPatch(
  options: ApplyPatchOptions
): Promise<StandardToolResponse<ApplyPatchData>> {
  const startTime = Date.now();
  const { workspaceRoot, allowedRoots = [], patch, expectedSha256Map } = options;

  if (!patch || !patch.trim()) {
    return {
      success: false,
      action: "apply_patch",
      text: "Empty patch provided. Nothing to apply.",
      verification: {
        performed: true,
        passed: false,
        method: "input_check",
        error: "Patch string is empty",
      },
      durationMs: Date.now() - startTime,
    };
  }

  activityStream.emit({
    type: "action_started",
    title: "Applying patch",
    purpose: "Parse diff hunks and apply verified atomic updates",
    tool: "apply_patch",
  });

  let filePatches: FilePatch[];
  try {
    filePatches = parsePatch(patch);
  } catch (err: any) {
    return {
      success: false,
      action: "apply_patch",
      text: `Patch parsing failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "patch_syntax_parser",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  if (filePatches.length === 0) {
    return {
      success: false,
      action: "apply_patch",
      text: "No valid file actions found in patch.",
      verification: {
        performed: true,
        passed: false,
        method: "patch_actions_count",
        error: "0 actions parsed",
      },
      durationMs: Date.now() - startTime,
    };
  }

  // ATOMIC PRE-VERIFICATION STAGE
  const plannedOps: PlannedOp[] = [];
  const filesModified: string[] = [];
  const filesAdded: string[] = [];
  const filesDeleted: string[] = [];
  const filesMoved: string[] = [];
  const diffSummaries: string[] = [];

  for (const fp of filePatches) {
    let resolvedTarget: string;
    try {
      resolvedTarget = resolveWorkspacePath(workspaceRoot, fp.filePath, allowedRoots);
    } catch (err: any) {
      return {
        success: false,
        action: `apply_patch "${fp.filePath}"`,
        text: `Security containment check failed for "${fp.filePath}": ${err.message}`,
        verification: {
          performed: true,
          passed: false,
          method: "path_containment_check",
          error: err.message,
        },
        durationMs: Date.now() - startTime,
      };
    }

    if (fp.type === "add") {
      const content = fp.addContent ?? "";
      plannedOps.push({
        type: "write",
        displayPath: fp.filePath,
        targetPath: resolvedTarget,
        newContent: content,
      });
      filesAdded.push(fp.filePath);
      diffSummaries.push(`+++ added file ${fp.filePath} (${content.length} bytes)`);
    } else if (fp.type === "delete") {
      plannedOps.push({
        type: "delete",
        displayPath: fp.filePath,
        targetPath: resolvedTarget,
      });
      filesDeleted.push(fp.filePath);
      diffSummaries.push(`--- deleted file ${fp.filePath}`);
    } else if (fp.type === "move") {
      if (!fp.newFilePath) {
        return {
          success: false,
          action: "apply_patch (move)",
          text: `Move patch for "${fp.filePath}" is missing destination path.`,
          verification: {
            performed: true,
            passed: false,
            method: "move_params_check",
            error: "Missing newFilePath",
          },
          durationMs: Date.now() - startTime,
        };
      }
      let resolvedDest: string;
      try {
        resolvedDest = resolveWorkspacePath(workspaceRoot, fp.newFilePath, allowedRoots);
      } catch (err: any) {
        return {
          success: false,
          action: `apply_patch move "${fp.filePath}"`,
          text: `Destination path outside allowed roots: ${err.message}`,
          verification: {
            performed: true,
            passed: false,
            method: "path_containment_check",
            error: err.message,
          },
          durationMs: Date.now() - startTime,
        };
      }
      plannedOps.push({
        type: "move",
        displayPath: `${fp.filePath} -> ${fp.newFilePath}`,
        sourcePath: resolvedTarget,
        targetPath: resolvedDest,
      });
      filesMoved.push(`${fp.filePath} -> ${fp.newFilePath}`);
      diffSummaries.push(`renamed ${fp.filePath} -> ${fp.newFilePath}`);
    } else if (fp.type === "update") {
      let originalContent = "";
      try {
        originalContent = await fs.readFile(resolvedTarget, "utf-8");
      } catch (err: any) {
        return {
          success: false,
          error_code: "FILE_NOT_FOUND",
          action: `apply_patch update "${fp.filePath}"`,
          text: `Cannot update "${fp.filePath}": file does not exist or is unreadable (${err.message})`,
          summary: `Target file not readable: ${fp.filePath}`,
          verification: {
            performed: true,
            passed: false,
            method: "read_target_file",
            error: err.message,
          },
          durationMs: Date.now() - startTime,
        };
      }

      if (expectedSha256Map && expectedSha256Map[fp.filePath]) {
        const expected = expectedSha256Map[fp.filePath];
        const actualHash = crypto.createHash("sha256").update(Buffer.from(originalContent)).digest("hex");
        if (actualHash !== expected) {
          return {
            success: false,
            error_code: "FILE_CHANGED_SINCE_READ",
            action: `apply_patch update "${fp.filePath}"`,
            text: `Precondition failed: file "${fp.filePath}" has changed since last read. Expected SHA-256 "${expected}", found "${actualHash}".`,
            summary: `Concurrent edit conflict on ${fp.filePath}`,
            verification: {
              performed: true,
              passed: false,
              method: "expected_sha256_precondition_check",
              error: `Hash mismatch for ${fp.filePath}: expected ${expected}, actual ${actualHash}`,
              execution: { status: "failed", method: "expected_sha256_precondition_check" },
              state: { status: "not_performed" },
            },
            durationMs: Date.now() - startTime,
          };
        }
      }

      let updatedContent = "";
      try {
        updatedContent = applyHunksToContent(originalContent, fp.hunks, fp.filePath);
      } catch (err: any) {
        return {
          success: false,
          error_code: "PATCH_CONTEXT_MISMATCH",
          action: `apply_patch update "${fp.filePath}"`,
          text: `Failed applying hunks to "${fp.filePath}": ${err.message}`,
          summary: `Hunk context mismatch in ${fp.filePath}`,
          verification: {
            performed: true,
            passed: false,
            method: "hunk_application",
            error: err.message,
            execution: { status: "failed", method: "hunk_application", error: err.message },
            state: { status: "not_performed" },
          },
          durationMs: Date.now() - startTime,
        };
      }

      // CRITICAL GUARD: False-Success Prevention (detect unmatched patch hunks)
      // If updatedContent is identical to originalContent, this patch is a NO-OP.
      if (updatedContent === originalContent) {
        return {
          success: false,
          action: `apply_patch update "${fp.filePath}"`,
          text: `CRITICAL: Patch applied to "${fp.filePath}" resulted in NO CHANGES. The content is identical to disk state. Refusing to report false success.`,
          verification: {
            performed: true,
            passed: false,
            method: "noop_change_detection",
            error: "Updated content identical to original content",
          },
          durationMs: Date.now() - startTime,
        };
      }

      const generatedDiff = diff.createPatch(fp.filePath, originalContent, updatedContent, "original", "patched");
      diffSummaries.push(generatedDiff);

      plannedOps.push({
        type: "write",
        displayPath: fp.filePath,
        targetPath: resolvedTarget,
        originalContent,
        newContent: updatedContent,
      });
      filesModified.push(fp.filePath);
    }
  }

  // ATOMIC COMMIT: Apply all operations to disk
  const completedOps: PlannedOp[] = [];
  try {
    for (const op of plannedOps) {
      if (op.type === "write") {
        await fs.mkdir(path.dirname(op.targetPath), { recursive: true });
        await fs.writeFile(op.targetPath, op.newContent ?? "", "utf-8");
      } else if (op.type === "delete") {
        await fs.unlink(op.targetPath);
      } else if (op.type === "move") {
        await fs.mkdir(path.dirname(op.targetPath), { recursive: true });
        if (op.sourcePath) {
          await fs.rename(op.sourcePath, op.targetPath);
        }
      }
      completedOps.push(op);
    }
  } catch (err: any) {
    // Rollback completed operations
    for (const op of completedOps) {
      try {
        if (op.type === "write" && op.originalContent !== undefined) {
          await fs.writeFile(op.targetPath, op.originalContent, "utf-8");
        }
      } catch {}
    }
    return {
      success: false,
      action: "apply_patch commit",
      text: `Error during patch commit: ${err.message}. Rollback executed.`,
      verification: {
        performed: true,
        passed: false,
        method: "atomic_commit",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  // MANDATORY POST-COMMIT VERIFICATION OF ALL FILES
  const verifications: Record<string, VerificationResult> = {};
  let allPassed = true;
  let failureDetails = "";

  for (const op of plannedOps) {
    if (op.type === "write") {
      const v = await verifyFileContent(op.targetPath, op.newContent ?? "");
      verifications[op.displayPath] = v;
      if (!v.passed) {
        allPassed = false;
        failureDetails += `\nVerification failed for ${op.displayPath}: ${v.error}`;
      }
    } else if (op.type === "delete") {
      const v = await verifyFileExistence(op.targetPath, false);
      verifications[op.displayPath] = v;
      if (!v.passed) {
        allPassed = false;
        failureDetails += `\nDeletion verification failed for ${op.displayPath}: ${v.error}`;
      }
    } else if (op.type === "move") {
      const v = await verifyFileRelocation(op.sourcePath ?? "", op.targetPath);
      verifications[op.displayPath] = v;
      if (!v.passed) {
        allPassed = false;
        failureDetails += `\nMove verification failed for ${op.displayPath}: ${v.error}`;
      }
    }
  }

  if (!allPassed) {
    return {
      success: false,
      error_code: "PATCH_VERIFICATION_FAILED",
      action: "apply_patch verification",
      text: `Patch committed but failed post-mutation verification:${failureDetails}`,
      summary: "Post-mutation verification failed",
      verification: {
        performed: true,
        passed: false,
        method: "post_mutation_verification",
        error: failureDetails,
        details: { verifications },
        execution: { status: "passed", method: "atomic_commit" },
        state: { status: "failed", method: "post_mutation_verification", error: failureDetails },
      },
      durationMs: Date.now() - startTime,
    };
  }

  const summary = [
    `Patch applied and verified successfully across ${plannedOps.length} file operation(s):`,
    filesModified.length > 0 ? `- Modified: ${filesModified.join(", ")}` : null,
    filesAdded.length > 0 ? `- Added: ${filesAdded.join(", ")}` : null,
    filesDeleted.length > 0 ? `- Deleted: ${filesDeleted.join(", ")}` : null,
    filesMoved.length > 0 ? `- Moved: ${filesMoved.join(", ")}` : null,
    "\n--- Changes ---",
    ...diffSummaries,
  ]
    .filter(Boolean)
    .join("\n");

  activityStream.emit({
    type: "verification",
    title: "Patch disk write and SHA-256 verified",
    tool: "apply_patch",
    evidence: { plannedOpsCount: plannedOps.length },
  });

  activityStream.emit({
    type: "action_completed",
    title: `Patch applied successfully across ${plannedOps.length} file(s)`,
    tool: "apply_patch",
  });

  return {
    success: true,
    action: "apply_patch",
    display_title: "Applying patch",
    display_status: "verified",
    text: summary,
    verification: {
      performed: true,
      passed: true,
      method: "post_mutation_sha256_and_existence_verification",
      details: {
        filesModified,
        filesAdded,
        filesDeleted,
        filesMoved,
      },
    },
    data: {
      filesModified,
      filesAdded,
      filesDeleted,
      filesMoved,
      diffSummary: diffSummaries.join("\n"),
      verifications,
    },
    durationMs: Date.now() - startTime,
  };
}
