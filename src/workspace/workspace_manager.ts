import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Workspace, StandardToolResponse, DetectedShells, SkillInfo } from "../types/index.js";
import { assertPathWithinRoots, normalizePath } from "../security/roots.js";
import { generateRepoMap } from "./repo_map.js";
import { loadInstructions } from "./instructions.js";
import { discoverSkills } from "./skills.js";
import { detectShells } from "../shell/shell_detector.js";
import { executeGitStatus } from "../git/git_ops.js";

export interface OpenWorkspaceResult {
  workspace: Workspace;
  git: {
    branch: string;
    isClean: boolean;
    modifiedCount: number;
  };
  shells: DetectedShells;
  skills: SkillInfo[];
  os: {
    platform: string;
    release: string;
    arch: string;
  };
}

export class WorkspaceManager {
  private activeWorkspaces = new Map<string, Workspace>();
  private defaultWorkspaceId?: string;

  public async openWorkspace(
    targetPath?: string,
    allowedRoots: string[] = []
  ): Promise<StandardToolResponse<OpenWorkspaceResult>> {
    const startTime = Date.now();
    const rawPath = targetPath ? path.resolve(targetPath) : process.cwd();

    let root: string;
    try {
      root = assertPathWithinRoots(rawPath, allowedRoots);
    } catch (err: any) {
      return {
        success: false,
        action: `open_workspace "${rawPath}"`,
        text: `Security containment check failed: ${err.message}`,
        verification: {
          performed: true,
          passed: false,
          method: "path_containment_check",
          error: err.message,
        },
        durationMs: Date.now() - startTime,
      };
    }

    const id = `ws_${randomUUID().slice(0, 8)}`;
    const [repoMap, instructions, skills, gitRes] = await Promise.all([
      generateRepoMap(root),
      loadInstructions(root),
      discoverSkills(root),
      Promise.resolve(executeGitStatus(root)),
    ]);

    const shells = detectShells();

    const workspace: Workspace = {
      id,
      root,
      mode: "checkout",
      instructions,
      repoMap,
      createdAt: Date.now(),
    };

    this.activeWorkspaces.set(id, workspace);
    this.defaultWorkspaceId = id;

    const git = {
      branch: gitRes.data?.branch || "none",
      isClean: Boolean(gitRes.data?.isClean),
      modifiedCount: (gitRes.data?.modified.length || 0) + (gitRes.data?.untracked.length || 0),
    };

    const osInfo = {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
    };

    // Format rich welcoming context for agent
    const lines = [
      `[DevSpace 4.0] Workspace opened: ${root} (Handle: ${id})`,
      `Repository Summary: ${repoMap.summary}`,
      `Git: branch "${git.branch}" (${git.isClean ? "clean" : `${git.modifiedCount} uncommitted changes`})`,
      `Languages: ${repoMap.languages.join(", ") || "generic"}`,
      `Available Shells: ${Object.entries(shells)
        .filter(([k, v]) => typeof v === "object" && v.available)
        .map(([k, v]: any) => `${k} (${v.description})`)
        .join(", ")} | Default: ${shells.defaultShell}`,
    ];

    if (Object.keys(repoMap.scripts).length > 0) {
      lines.push(`Package Scripts: ${Object.keys(repoMap.scripts).join(", ")}`);
    }

    if (skills.length > 0) {
      lines.push(`Discovered Skills (${skills.length}): ${skills.map((s) => `${s.name} [${s.source}]`).join(", ")}`);
    }

    if (instructions) {
      lines.push(`\nInstruction Context Loaded:\n${instructions.slice(0, 500)}...`);
    }

    return {
      success: true,
      action: `open_workspace "${root}"`,
      text: lines.join("\n"),
      verification: {
        performed: true,
        passed: true,
        method: "workspace_root_validation_and_scanning",
        details: { workspaceId: id, root },
      },
      data: {
        workspace,
        git,
        shells,
        skills,
        os: osInfo,
      },
      durationMs: Date.now() - startTime,
    };
  }

  public getWorkspace(id?: string): Workspace | undefined {
    if (id) return this.activeWorkspaces.get(id);
    if (this.defaultWorkspaceId) return this.activeWorkspaces.get(this.defaultWorkspaceId);
    return this.activeWorkspaces.values().next().value;
  }

  public getActiveWorkspaceRoot(): string {
    const ws = this.getWorkspace();
    return ws?.root || process.cwd();
  }
}

export const workspaceManager = new WorkspaceManager();
