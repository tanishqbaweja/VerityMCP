import { execSync } from "node:child_process";
import path from "node:path";
import type { StandardToolResponse } from "../types/index.js";

export interface GitStatusInfo {
  isGitRepo: boolean;
  branch: string;
  isClean: boolean;
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
  renamed: string[];
  rawStatus: string;
}

export function executeGitStatus(workspaceRoot: string): StandardToolResponse<GitStatusInfo> {
  const startTime = Date.now();
  try {
    const rawBranch = execSync("git branch --show-current", {
      cwd: workspaceRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const rawStatus = execSync("git status --porcelain=v1", {
      cwd: workspaceRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    const modified: string[] = [];
    const added: string[] = [];
    const deleted: string[] = [];
    const untracked: string[] = [];
    const renamed: string[] = [];

    const lines = rawStatus.split(/\r?\n/).filter((l) => l.trim().length > 0);

    for (const line of lines) {
      const code = line.slice(0, 2);
      const filePath = line.slice(3).trim();

      if (code.includes("M")) modified.push(filePath);
      else if (code.includes("A")) added.push(filePath);
      else if (code.includes("D")) deleted.push(filePath);
      else if (code.includes("R")) renamed.push(filePath);
      else if (code === "??") untracked.push(filePath);
    }

    const isClean = lines.length === 0;
    const branch = rawBranch || "HEAD (detached)";

    const data: GitStatusInfo = {
      isGitRepo: true,
      branch,
      isClean,
      modified,
      added,
      deleted,
      untracked,
      renamed,
      rawStatus,
    };

    const text = isClean
      ? `Git branch: ${branch} (working tree clean)`
      : `Git branch: ${branch} (dirty: ${modified.length} modified, ${added.length} added, ${deleted.length} deleted, ${untracked.length} untracked)`;

    return {
      success: true,
      action: "git_status",
      text,
      verification: {
        performed: true,
        passed: true,
        method: "git_porcelain_inspection",
        details: { branch, isClean, totalChanges: lines.length },
      },
      data,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: true,
      action: "git_status",
      text: "Not a git repository or git command unavailable.",
      verification: {
        performed: true,
        passed: true,
        method: "git_check",
        details: { isGitRepo: false },
      },
      data: {
        isGitRepo: false,
        branch: "",
        isClean: true,
        modified: [],
        added: [],
        deleted: [],
        untracked: [],
        renamed: [],
        rawStatus: "",
      },
      durationMs: Date.now() - startTime,
    };
  }
}

export function executeGitDiff(
  workspaceRoot: string,
  options?: { targetRef?: string; filePaths?: string[] }
): StandardToolResponse<{ diff: string; filesChanged: number }> {
  const startTime = Date.now();
  try {
    const target = options?.targetRef ? options.targetRef : "HEAD";
    const files = options?.filePaths && options.filePaths.length > 0 ? `-- ${options.filePaths.join(" ")}` : "";
    const cmd = `git diff ${target} ${files}`.trim();

    const diff = execSync(cmd, {
      cwd: workspaceRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    const fileHeaders = (diff.match(/^diff --git /gm) || []).length;

    return {
      success: true,
      action: `git_diff`,
      text: diff.trim() ? diff : "No changes detected against base ref.",
      verification: {
        performed: true,
        passed: true,
        method: "git_diff_execution",
        details: { filesChanged: fileHeaders },
      },
      data: { diff, filesChanged: fileHeaders },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: "git_diff",
      text: `git diff failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "git_diff",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }
}

export function executeShowChanges(workspaceRoot: string): StandardToolResponse<{
  status: GitStatusInfo;
  diff: string;
}> {
  const startTime = Date.now();
  const statusRes = executeGitStatus(workspaceRoot);
  const diffRes = executeGitDiff(workspaceRoot);

  const lines = [
    statusRes.text,
    "\n--- Changes ---",
    diffRes.data?.diff || "No git diff available.",
  ];

  return {
    success: true,
    action: "show_changes",
    text: lines.join("\n"),
    verification: {
      performed: true,
      passed: true,
      method: "git_status_and_diff_aggregation",
    },
    data: {
      status: statusRes.data!,
      diff: diffRes.data?.diff || "",
    },
    durationMs: Date.now() - startTime,
  };
}

export function executeRevertChanges(
  workspaceRoot: string,
  filePaths?: string[]
): StandardToolResponse<{ revertedFiles: string[]; resultingClean: boolean }> {
  const startTime = Date.now();
  try {
    if (filePaths && filePaths.length > 0) {
      // Revert specific files
      for (const f of filePaths) {
        try {
          execSync(`git checkout -- "${f}"`, { cwd: workspaceRoot, stdio: "ignore" });
        } catch {}
        try {
          execSync(`git clean -fd "${f}"`, { cwd: workspaceRoot, stdio: "ignore" });
        } catch {}
      }
    } else {
      // Revert all
      execSync("git checkout -- .", { cwd: workspaceRoot, stdio: "ignore" });
      execSync("git clean -fd", { cwd: workspaceRoot, stdio: "ignore" });
    }

    // MANDATORY POST-REVERT VERIFICATION
    const postStatus = executeGitStatus(workspaceRoot);
    const revertedList = filePaths && filePaths.length > 0 ? filePaths : ["all working files"];

    if (filePaths && filePaths.length > 0) {
      const stillDirty = filePaths.filter((f) =>
        postStatus.data?.modified.includes(f) ||
        postStatus.data?.untracked.includes(f) ||
        postStatus.data?.deleted.includes(f)
      );

      if (stillDirty.length > 0) {
        return {
          success: false,
          action: "revert_changes",
          text: `CRITICAL: Revert failed verification! The following file(s) are still dirty: ${stillDirty.join(", ")}`,
          verification: {
            performed: true,
            passed: false,
            method: "git_status_post_revert_verification",
            error: `Files still dirty: ${stillDirty.join(", ")}`,
          },
          durationMs: Date.now() - startTime,
        };
      }
    } else {
      if (!postStatus.data?.isClean) {
        return {
          success: false,
          action: "revert_changes",
          text: `CRITICAL: Revert all failed verification! Working directory is still dirty.`,
          verification: {
            performed: true,
            passed: false,
            method: "git_status_post_revert_verification",
            error: "Working tree is not clean after checkout/clean",
          },
          durationMs: Date.now() - startTime,
        };
      }
    }

    return {
      success: true,
      action: "revert_changes",
      text: `Successfully reverted changes for: ${revertedList.join(", ")}. Working tree status verified.`,
      verification: {
        performed: true,
        passed: true,
        method: "git_status_post_revert_verification",
        details: { resultingClean: postStatus.data?.isClean },
      },
      data: {
        revertedFiles: revertedList,
        resultingClean: Boolean(postStatus.data?.isClean),
      },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: "revert_changes",
      text: `Revert failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "git_revert_execution",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }
}
