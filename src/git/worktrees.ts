import path from "node:path";
import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import { workspaceManager } from "../workspace/workspace_manager.js";
import { executeGitStatus } from "./git_ops.js";
import type { StandardToolResponse } from "../types/index.js";

export interface WorktreeEntry {
  path: string;
  branch: string;
  headSha: string;
}

export function executeListWorktrees(workspaceRoot: string): StandardToolResponse<WorktreeEntry[]> {
  const startTime = Date.now();
  try {
    const raw = execSync("git worktree list --porcelain", {
      cwd: workspaceRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    const lines = raw.split(/\r?\n/);
    const worktrees: WorktreeEntry[] = [];
    let currentWt: Partial<WorktreeEntry> = {};

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        if (currentWt.path) {
          worktrees.push(currentWt as WorktreeEntry);
          currentWt = {};
        }
        currentWt.path = line.slice("worktree ".length).trim();
      } else if (line.startsWith("HEAD ")) {
        currentWt.headSha = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        currentWt.branch = line.slice("branch ".length).replace("refs/heads/", "").trim();
      }
    }
    if (currentWt.path) worktrees.push(currentWt as WorktreeEntry);

    const desc = worktrees.map((w) => `${w.branch || "detached"} at ${w.path} (${w.headSha?.slice(0, 8)})`);
    return {
      success: true,
      action: "git_worktree_list",
      text: worktrees.length > 0 ? `Git Worktrees (${worktrees.length}):\n${desc.join("\n")}` : "No additional git worktrees.",
      verification: { performed: true, passed: true, method: "git_worktree_porcelain", details: { count: worktrees.length } },
      data: worktrees,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: "git_worktree_list",
      text: `Failed to list worktrees: ${err.message}`,
      verification: { performed: true, passed: false, method: "git_worktree", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeEnterWorktree(options: {
  name?: string;
  baseRef?: string;
}): Promise<StandardToolResponse<{ worktreePath: string; branch: string }>> {
  const startTime = Date.now();
  const ws = workspaceManager.getWorkspace();
  if (!ws) {
    return {
      success: false,
      action: "enter_worktree",
      text: "No active workspace.",
      verification: { performed: true, passed: false, method: "workspace_check" },
      durationMs: Date.now() - startTime,
    };
  }

  const baseDir = ws.sourceRoot || ws.root;
  const branchName = options.name || `wt-${Date.now().toString(36)}`;
  const worktreePath = path.join(baseDir, ".worktrees", branchName);

  try {
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    const baseRef = options.baseRef || "HEAD";

    execSync(`git worktree add -b "${branchName}" "${worktreePath}" "${baseRef}"`, {
      cwd: baseDir,
      stdio: "pipe",
    });

    ws.sourceRoot = baseDir;
    ws.root = worktreePath;
    ws.mode = "worktree";
    ws.worktree = {
      path: worktreePath,
      branch: branchName,
      baseRef,
    };

    return {
      success: true,
      action: `enter_worktree "${branchName}"`,
      text: `Switched into isolated worktree at ${worktreePath} on branch "${branchName}". Workspace root updated.`,
      verification: {
        performed: true,
        passed: true,
        method: "git_worktree_add",
        details: { branch: branchName, path: worktreePath },
      },
      data: { worktreePath, branch: branchName },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: `enter_worktree "${branchName}"`,
      text: `Failed creating worktree: ${err.message}`,
      verification: { performed: true, passed: false, method: "git_worktree_add", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeExitWorktree(options: {
  action: "keep" | "remove";
  force?: boolean;
}): Promise<StandardToolResponse<{ action: string; originalRoot: string }>> {
  const startTime = Date.now();
  const ws = workspaceManager.getWorkspace();
  if (!ws || !ws.worktree || !ws.sourceRoot) {
    return {
      success: false,
      action: "exit_worktree",
      text: "Current workspace is not operating inside a worktree.",
      verification: { performed: true, passed: false, method: "worktree_mode_guard" },
      durationMs: Date.now() - startTime,
    };
  }

  const { path: wtPath, branch } = ws.worktree;
  const parentRoot = ws.sourceRoot;

  if (options.action === "remove") {
    // DIRTY-STATE PROTECTION
    const status = executeGitStatus(wtPath);
    if (!status.data?.isClean && !options.force) {
      return {
        success: false,
        error_code: "WORKTREE_DIRTY",
        action: "exit_worktree",
        text: `CRITICAL: Worktree "${branch}" contains uncommitted changes. Refusing to delete without force: true.`,
        summary: `Worktree contains uncommitted changes (requires force: true)`,
        verification: {
          performed: true,
          passed: false,
          method: "worktree_dirty_state_guard",
          error: "Worktree has uncommitted modifications",
        },
        durationMs: Date.now() - startTime,
      };
    }

    try {
      const forceArg = options.force ? "--force" : "";
      execSync(`git worktree remove ${forceArg} "${wtPath}"`.trim(), { cwd: parentRoot, stdio: "ignore" });
      if (options.force) {
        try {
          execSync(`git branch -D "${branch}"`, { cwd: parentRoot, stdio: "ignore" });
        } catch {}
      }
    } catch (err: any) {
      return {
        success: false,
        action: "exit_worktree",
        text: `Failed to remove worktree: ${err.message}`,
        verification: { performed: true, passed: false, method: "git_worktree_remove", error: err.message },
        durationMs: Date.now() - startTime,
      };
    }
  }

  ws.root = parentRoot;
  ws.sourceRoot = undefined;
  ws.worktree = undefined;
  ws.mode = "checkout";

  return {
    success: true,
    action: `exit_worktree (${options.action})`,
    text: `Exited worktree. Active workspace root restored to ${parentRoot}.`,
    verification: { performed: true, passed: true, method: "workspace_root_restored" },
    data: { action: options.action, originalRoot: parentRoot },
    durationMs: Date.now() - startTime,
  };
}
