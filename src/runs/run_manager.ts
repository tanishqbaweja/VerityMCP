import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { execSync } from "node:child_process";
import {
  getServerRoot,
  getPersistentDataRoot,
  getRunsDir,
  getStateDir,
  getActiveRunPath,
  getRunDirPath,
  ensureDirectoriesExist,
  getPersistentDiskUsageBytes,
} from "../storage/paths.js";
import {
  atomicWriteJson,
  atomicWriteFile,
  sanitizeObject,
  generateRunSummaryMarkdown,
} from "./utils.js";
import { activityStream, type ActivityEvent } from "../observability/activity_stream.js";
import { calculateSha256 } from "../verification/index.js";
import { browserManager } from "../browser/browser_manager.js";
import { processManager } from "../shell/process_manager.js";
import type {
  RunMetadata,
  RunStatus,
  Phase,
  ModifiedFile,
  CleanupDebtItem,
  TrackedTemporaryFile,
  TrackedBrowserSession,
  TrackedProcessSession,
  TrackedWorktree,
  Checkpoint,
  ActiveRunPointer,
  RunResumeResult,
} from "./types.js";

export class RunManager {
  private activeRun: RunMetadata | null = null;
  private initialized = false;
  private eventWriteStreams = new Map<string, fs.WriteStream>();

  constructor() {}

  /**
   * Initialize run manager on server startup.
   * Detects interrupted runs from previous process crashes or computer restarts.
   */
  public async init(): Promise<void> {
    if (this.initialized) return;
    await ensureDirectoriesExist();

    const activePointerPath = getActiveRunPath();
    if (fs.existsSync(activePointerPath)) {
      try {
        const raw = await fsp.readFile(activePointerPath, "utf-8");
        const pointer: ActiveRunPointer = JSON.parse(raw);

        // If prior state was "running", but this is a new process session:
        if (pointer.status === "running" && pointer.server_pid !== process.pid) {
          const runJsonPath = path.join(getRunDirPath(pointer.run_id), "run.json");
          if (fs.existsSync(runJsonPath)) {
            const runRaw = await fsp.readFile(runJsonPath, "utf-8");
            const runData: RunMetadata = JSON.parse(runRaw);

            runData.status = "interrupted";
            runData.updated_at = new Date().toISOString();
            runData.warnings.push("Server process ended abruptly while run was in progress. Marked as interrupted on restart.");

            await atomicWriteJson(runJsonPath, runData);
            await atomicWriteFile(
              path.join(getRunDirPath(pointer.run_id), "summary.md"),
              generateRunSummaryMarkdown(runData)
            );

            pointer.status = "interrupted";
            pointer.updated_at = runData.updated_at;
            await atomicWriteJson(activePointerPath, pointer);
          }
        } else if (pointer.status === "running") {
          const runJsonPath = path.join(getRunDirPath(pointer.run_id), "run.json");
          if (fs.existsSync(runJsonPath)) {
            const runRaw = await fsp.readFile(runJsonPath, "utf-8");
            this.activeRun = JSON.parse(runRaw);
          }
        }
      } catch (err: any) {
        console.warn(`[VerityRunManager] Failed inspecting prior active run: ${err.message}`);
      }
    }

    activityStream.subscribe((event) => this.appendActivityEvent(event));
    this.initialized = true;
  }

  public getActiveRun(): RunMetadata | null {
    return this.activeRun;
  }

  public generateRunId(): string {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 6);
    return `run_${dateStr}_${rand}`;
  }

  /**
   * Start a new durable run.
   */
  public async startRun(options: {
    goal: string;
    workspace?: string;
    purpose?: string;
    phases?: Phase[];
    metadata?: Record<string, unknown>;
  }): Promise<{
    run: RunMetadata;
    storage_path: string;
    monitor_url: string;
    ui_resource_uri: string;
  }> {
    await this.init();

    const runId = this.generateRunId();
    const now = new Date().toISOString();
    const serverRoot = getServerRoot();
    const workspace = options.workspace || process.cwd();
    const runDir = getRunDirPath(runId);

    await fsp.mkdir(runDir, { recursive: true });

    const initialPhases: Phase[] =
      options.phases && options.phases.length > 0
        ? options.phases
        : [
            { id: "init", title: "Initialize & Inspect Environment", status: "completed" },
            { id: "execution", title: "Autonomous Goal Execution", status: "in_progress" },
            { id: "verification", title: "Verification & Integrity Audit", status: "pending" },
            { id: "cleanup", title: "Resource Cleanup", status: "pending" },
          ];

    const run: RunMetadata = {
      run_id: runId,
      started_at: now,
      updated_at: now,
      status: "running",
      original_goal: options.goal,
      current_goal: options.goal,
      workspace,
      server_root: serverRoot,
      current_purpose: options.purpose,
      completed_steps: ["Run initialized"],
      pending_steps: ["Execute goal phases"],
      phases: initialPhases,
      warnings: [],
      failures: [],
      modified_files: [],
      temporary_files: [],
      browser_sessions: [],
      process_sessions: [],
      worktrees: [],
      cleanup_debt: [],
      last_activity_cursor: 0,
      server_pid: process.pid,
      metadata: options.metadata || {},
    };

    this.activeRun = run;

    // Create empty events.jsonl
    await fsp.writeFile(path.join(runDir, "events.jsonl"), "", "utf-8");

    // Write run.json, checkpoint.json, resources.json, summary.md
    await atomicWriteJson(path.join(runDir, "run.json"), run);
    await atomicWriteJson(path.join(runDir, "checkpoint.json"), {
      checkpoint_id: `chk_${Date.now()}`,
      timestamp: now,
      completed: run.completed_steps,
      current: run.current_action || "Run initialized",
      pending: run.pending_steps,
      phases: run.phases,
    });
    await atomicWriteJson(path.join(runDir, "resources.json"), {
      browser_sessions: run.browser_sessions,
      process_sessions: run.process_sessions,
      temporary_files: run.temporary_files,
      worktrees: run.worktrees,
      cleanup_debt: run.cleanup_debt,
    });
    await atomicWriteFile(
      path.join(runDir, "summary.md"),
      generateRunSummaryMarkdown(run)
    );

    // Update active run pointer
    const pointer: ActiveRunPointer = {
      run_id: runId,
      status: "running",
      last_checkpoint: now,
      workspace,
      started_at: now,
      updated_at: now,
      server_pid: process.pid,
    };
    await atomicWriteJson(getActiveRunPath(), pointer);

    // Emit activity event
    activityStream.emit({
      type: "plan",
      title: `Started durable run: ${runId}`,
      display_title: `Run started: ${run.original_goal.slice(0, 50)}`,
      purpose: options.purpose || `Execute autonomous goal: ${options.goal}`,
      purpose_source: options.purpose ? "caller" : "tool_default",
      status: "running",
      details: { run_id: runId, workspace },
    });

    return {
      run,
      storage_path: runDir,
      monitor_url: `http://localhost:${process.env.VERITY_PORT || 7980}/monitor`,
      ui_resource_uri: "ui://verity/activity-monitor",
    };
  }

  /**
   * Append an activity event immediately to the active run's events.jsonl.
   */
  public appendActivityEvent(event: ActivityEvent): void {
    if (!this.activeRun) return;

    const runId = this.activeRun.run_id;
    const runDir = getRunDirPath(runId);
    const eventsFile = path.join(runDir, "events.jsonl");

    const sanitized = sanitizeObject(event);
    const line = JSON.stringify(sanitized) + "\n";

    try {
      fs.appendFileSync(eventsFile, line, "utf-8");
    } catch {}

    this.activeRun.last_activity_cursor = event.seq;
    this.activeRun.updated_at = new Date().toISOString();

    if (event.type === "action_started") {
      this.activeRun.current_action = event;
      if (event.purpose) this.activeRun.current_purpose = event.purpose;
      if (event.target) this.activeRun.current_target = event.target;
    } else if (event.type === "action_completed" || event.type === "failure") {
      if (
        this.activeRun.current_action &&
        typeof this.activeRun.current_action === "object" &&
        this.activeRun.current_action.call_id === event.call_id
      ) {
        this.activeRun.current_action = undefined;
      }
      if (event.type === "failure") {
        this.activeRun.failures.push(event.title || "Operation failed");
      }
    } else if (event.type === "warning") {
      this.activeRun.warnings.push(event.title || "Warning encountered");
    }
  }

  /**
   * Update durable checkpoint.
   */
  public async checkpointRun(
    runId?: string,
    update?: {
      completed?: string[];
      current?: string;
      pending?: string[];
      phases?: Phase[];
      notes?: string;
    }
  ): Promise<Checkpoint> {
    await this.init();
    const targetId = runId || this.activeRun?.run_id;
    if (!targetId) {
      throw new Error("No active run to checkpoint and no run_id supplied.");
    }

    const runDir = getRunDirPath(targetId);
    const runJsonPath = path.join(runDir, "run.json");
    if (!fs.existsSync(runJsonPath)) {
      throw new Error(`Run "${targetId}" not found at ${runDir}`);
    }

    const runData: RunMetadata = JSON.parse(await fsp.readFile(runJsonPath, "utf-8"));
    const now = new Date().toISOString();

    if (update?.completed) {
      for (const step of update.completed) {
        if (!runData.completed_steps.includes(step)) {
          runData.completed_steps.push(step);
        }
      }
    }
    if (update?.pending) {
      runData.pending_steps = update.pending;
    }
    if (update?.current) {
      runData.current_action = update.current;
    }
    if (update?.phases) {
      runData.phases = update.phases;
    }

    const checkpoint: Checkpoint = {
      checkpoint_id: `chk_${Date.now()}`,
      timestamp: now,
      completed: runData.completed_steps,
      current: typeof runData.current_action === "string" ? runData.current_action : runData.current_action?.title,
      pending: runData.pending_steps,
      phases: runData.phases,
      notes: update?.notes,
    };

    runData.last_checkpoint = checkpoint;
    runData.updated_at = now;

    if (this.activeRun && this.activeRun.run_id === targetId) {
      this.activeRun = runData;
    }

    await atomicWriteJson(path.join(runDir, "checkpoint.json"), checkpoint);
    await atomicWriteJson(runJsonPath, runData);
    await atomicWriteFile(path.join(runDir, "summary.md"), generateRunSummaryMarkdown(runData));

    // Update active pointer
    if (runData.status === "running") {
      const pointer: ActiveRunPointer = {
        run_id: targetId,
        status: runData.status,
        last_checkpoint: now,
        workspace: runData.workspace,
        started_at: runData.started_at,
        updated_at: now,
        server_pid: process.pid,
      };
      await atomicWriteJson(getActiveRunPath(), pointer);
    }

    activityStream.emit({
      type: "verification",
      title: `Durable checkpoint saved: ${checkpoint.checkpoint_id}`,
      display_title: "Run checkpoint recorded",
      status: "verified",
      evidence: { completed_count: checkpoint.completed.length, pending_count: checkpoint.pending.length },
    });

    return checkpoint;
  }

  /**
   * Track modified files.
   */
  public async trackModifiedFile(modified: ModifiedFile): Promise<void> {
    if (!this.activeRun) return;
    this.activeRun.modified_files.push(modified);
    const runDir = getRunDirPath(this.activeRun.run_id);
    await atomicWriteJson(path.join(runDir, "run.json"), this.activeRun);
  }

  /**
   * Track temporary files and add to cleanup debt.
   */
  public async trackTemporaryFile(filePath: string, purpose?: string, cleanupRequired = true): Promise<void> {
    if (!this.activeRun) return;
    const now = new Date().toISOString();
    const tempFile: TrackedTemporaryFile = {
      path: filePath,
      purpose,
      cleanup_required: cleanupRequired,
      created_at: now,
    };
    this.activeRun.temporary_files.push(tempFile);

    if (cleanupRequired) {
      const debtId = `debt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      this.activeRun.cleanup_debt.push({
        id: debtId,
        type: "temporary_file",
        path: filePath,
        description: purpose || "Temporary test artifact",
        resolved: false,
      });
    }

    const runDir = getRunDirPath(this.activeRun.run_id);
    await atomicWriteJson(path.join(runDir, "run.json"), this.activeRun);
    await atomicWriteJson(path.join(runDir, "resources.json"), {
      browser_sessions: this.activeRun.browser_sessions,
      process_sessions: this.activeRun.process_sessions,
      temporary_files: this.activeRun.temporary_files,
      worktrees: this.activeRun.worktrees,
      cleanup_debt: this.activeRun.cleanup_debt,
    });
  }

  /**
   * Resolve a cleanup debt item.
   */
  public async resolveCleanupDebt(idOrPath: string): Promise<void> {
    if (!this.activeRun) return;
    const item = this.activeRun.cleanup_debt.find(
      (c) => c.id === idOrPath || c.path === idOrPath || c.resource_id === idOrPath
    );
    if (item) {
      item.resolved = true;
      item.resolved_at = new Date().toISOString();
      const runDir = getRunDirPath(this.activeRun.run_id);
      await atomicWriteJson(path.join(runDir, "run.json"), this.activeRun);
    }
  }

  /**
   * Reconcile real system state and resume run context.
   */
  public async resumeRun(runId?: string): Promise<RunResumeResult> {
    await this.init();

    let targetId = runId;
    if (!targetId) {
      // Find active run pointer first
      const activePointerPath = getActiveRunPath();
      if (fs.existsSync(activePointerPath)) {
        try {
          const raw = await fsp.readFile(activePointerPath, "utf-8");
          const ptr: ActiveRunPointer = JSON.parse(raw);
          targetId = ptr.run_id;
        } catch {}
      }

      // If still none, find most recent incomplete or latest run
      if (!targetId) {
        const runs = await this.listRuns({ limit: 10 });
        const incomplete = runs.find((r) => r.status === "interrupted" || r.status === "running");
        targetId = incomplete ? incomplete.run_id : runs[0]?.run_id;
      }
    }

    if (!targetId) {
      throw new Error("No prior Verity run found to resume.");
    }

    const runDir = getRunDirPath(targetId);
    const runJsonPath = path.join(runDir, "run.json");
    if (!fs.existsSync(runJsonPath)) {
      throw new Error(`Run "${targetId}" not found in persistent store (${runDir}).`);
    }

    const run: RunMetadata = JSON.parse(await fsp.readFile(runJsonPath, "utf-8"));
    this.activeRun = run;

    // Reconciliation 1: Check modified files on physical disk
    const fileReconciliations: Array<{ path: string; current_hash?: string; matches_post_hash: boolean; exists: boolean }> = [];
    for (const mf of run.modified_files) {
      let exists = false;
      let currentHash: string | undefined = undefined;
      let matches = false;
      try {
        if (fs.existsSync(mf.path)) {
          exists = true;
          const content = await fsp.readFile(mf.path);
          currentHash = calculateSha256(content);
          matches = Boolean(mf.post_hash && currentHash === mf.post_hash);
        }
      } catch {}
      fileReconciliations.push({
        path: mf.path,
        current_hash: currentHash,
        matches_post_hash: matches,
        exists,
      });
    }

    // Reconciliation 2: Git status in workspace
    let gitClean = true;
    let gitBranch: string | undefined = undefined;
    const warnings: string[] = [];
    try {
      if (fs.existsSync(path.join(run.workspace, ".git"))) {
        gitBranch = execSync("git branch --show-current", {
          cwd: run.workspace,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();

        const statusOut = execSync("git status --porcelain", {
          cwd: run.workspace,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        gitClean = statusOut.length === 0;
        if (!gitClean) {
          warnings.push(`Git working tree in workspace "${run.workspace}" has uncommitted changes.`);
        }
      }
    } catch {}

    // Reconciliation 3: Check live browser sessions in memory
    const liveBrowserSessions = browserManager.listSessions();
    const aliveBrowserIds = liveBrowserSessions.map((s) => s.id);
    for (const bs of run.browser_sessions) {
      if (!aliveBrowserIds.includes(bs.id)) {
        bs.active = false;
        warnings.push(`Browser session "${bs.id}" was active when interrupted but is no longer open.`);
      }
    }

    // Reconciliation 4: Check live process sessions
    const liveProcessSessions = processManager.listSessions();
    const aliveProcessIds = liveProcessSessions.filter((s) => s.status === "running").map((s) => s.id);
    for (const ps of run.process_sessions) {
      if (ps.running && !aliveProcessIds.includes(ps.id)) {
        ps.running = false;
        warnings.push(`Background process "${ps.id}" (PID ${ps.pid}) has terminated since interruption.`);
      }
    }

    // Determine in progress and remaining
    const inProgress = typeof run.current_action === "string" ? run.current_action : run.current_action?.title;
    const remainingSteps = run.pending_steps.length > 0 ? run.pending_steps : ["Complete remaining phases and cleanup"];

    // Update status to running now that it has been resumed
    run.status = "running";
    run.updated_at = new Date().toISOString();
    await atomicWriteJson(runJsonPath, run);

    // Update active pointer
    await atomicWriteJson(getActiveRunPath(), {
      run_id: run.run_id,
      status: "running",
      last_checkpoint: run.last_checkpoint?.timestamp || run.updated_at,
      workspace: run.workspace,
      started_at: run.started_at,
      updated_at: run.updated_at,
      server_pid: process.pid,
    });

    activityStream.emit({
      type: "action_started",
      title: `Resumed durable run: ${run.run_id}`,
      display_title: `Run resumed: ${run.run_id}`,
      purpose: "Recover execution context and continue outstanding work",
      status: "running",
      details: { run_id: run.run_id, original_goal: run.original_goal },
    });

    const instruction =
      `RESUMED RUN ${run.run_id}. ` +
      `Original Goal: "${run.original_goal}". ` +
      `Completed work: [${run.completed_steps.join(", ")}]. ` +
      (inProgress ? `Interrupted during: "${inProgress}". Verify state before retrying. ` : "") +
      `Outstanding work: [${remainingSteps.join(", ")}]. ` +
      `Cleanup debt remaining: ${run.cleanup_debt.filter((c) => !c.resolved).length} items.`;

    return {
      recovered_run_id: run.run_id,
      status: run.status,
      original_goal: run.original_goal,
      current_goal: run.current_goal || run.original_goal,
      workspace: run.workspace,
      completed_steps: run.completed_steps,
      in_progress_when_interrupted: inProgress,
      last_successful_action: run.completed_steps[run.completed_steps.length - 1],
      current_remaining_steps: remainingSteps,
      phases: run.phases,
      active_resources: {
        browser_sessions: run.browser_sessions,
        process_sessions: run.process_sessions,
        worktrees: run.worktrees,
      },
      modified_files: run.modified_files,
      temporary_artifacts: run.temporary_files,
      cleanup_debt: run.cleanup_debt,
      reconciliation: {
        modified_files_reconciled: fileReconciliations,
        git_clean: gitClean,
        git_branch: gitBranch,
        browser_sessions_alive: aliveBrowserIds,
        process_sessions_alive: aliveProcessIds,
        warnings,
      },
      last_checkpoint: run.last_checkpoint,
      last_checkpoint_timestamp: run.last_checkpoint?.timestamp,
      instruction_for_agent: instruction,
    };
  }

  /**
   * Complete a run and audit cleanup debt.
   */
  public async completeRun(
    runId?: string,
    options?: {
      status?: "completed" | "failed" | "abandoned";
      notes?: string;
    }
  ): Promise<{
    run: RunMetadata;
    status: RunStatus;
    cleanup_warnings: string[];
    is_clean: boolean;
  }> {
    await this.init();
    const targetId = runId || this.activeRun?.run_id;
    if (!targetId) {
      throw new Error("No active run to complete and no run_id supplied.");
    }

    const runDir = getRunDirPath(targetId);
    const runJsonPath = path.join(runDir, "run.json");
    if (!fs.existsSync(runJsonPath)) {
      throw new Error(`Run "${targetId}" not found at ${runDir}`);
    }

    const run: RunMetadata = JSON.parse(await fsp.readFile(runJsonPath, "utf-8"));
    const finalStatus: RunStatus = options?.status || "completed";
    const now = new Date().toISOString();

    const cleanupWarnings: string[] = [];

    // Audit unresolved cleanup debt
    const unresolvedDebt = run.cleanup_debt.filter((c) => !c.resolved);
    if (unresolvedDebt.length > 0) {
      cleanupWarnings.push(
        `${unresolvedDebt.length} unresolved cleanup debt items remain: ${unresolvedDebt.map((c) => `${c.type}:${c.path || c.resource_id}`).join(", ")}`
      );
    }

    // Audit active browser sessions
    const activeBrowsers = browserManager.listSessions();
    if (activeBrowsers.length > 0) {
      cleanupWarnings.push(`${activeBrowsers.length} browser session(s) still open. Close them with browser_close.`);
    }

    // Audit active background processes
    const activeProcesses = processManager.listSessions().filter((p) => p.status === "running");
    if (activeProcesses.length > 0) {
      cleanupWarnings.push(`${activeProcesses.length} background process(es) still running.`);
    }

    run.status = finalStatus;
    run.updated_at = now;
    if (options?.notes) {
      run.completed_steps.push(`Completion Note: ${options.notes}`);
    }

    // Mark phases
    if (finalStatus === "completed") {
      run.phases = run.phases.map((p) => ({ ...p, status: "completed" }));
    }

    await atomicWriteJson(runJsonPath, run);
    await atomicWriteFile(path.join(runDir, "summary.md"), generateRunSummaryMarkdown(run));

    // Clear active pointer if this was active
    const activePointerPath = getActiveRunPath();
    if (fs.existsSync(activePointerPath)) {
      try {
        const raw = await fsp.readFile(activePointerPath, "utf-8");
        const ptr: ActiveRunPointer = JSON.parse(raw);
        if (ptr.run_id === targetId) {
          ptr.status = finalStatus;
          ptr.updated_at = now;
          await atomicWriteJson(activePointerPath, ptr);
        }
      } catch {}
    }

    if (this.activeRun && this.activeRun.run_id === targetId) {
      this.activeRun = null;
    }

    activityStream.emit({
      type: "action_completed",
      title: `Run ${finalStatus}: ${targetId}`,
      display_title: `Run ${finalStatus}`,
      status: finalStatus === "completed" ? "completed" : "failed",
      evidence: { cleanup_warnings: cleanupWarnings, final_status: finalStatus },
    });

    return {
      run,
      status: finalStatus,
      cleanup_warnings: cleanupWarnings,
      is_clean: cleanupWarnings.length === 0,
    };
  }

  /**
   * List all persisted runs from <persistentDataRoot>/runs.
   */
  public async listRuns(options?: {
    status?: string;
    limit?: number;
  }): Promise<
    Array<{
      run_id: string;
      goal: string;
      status: RunStatus;
      workspace: string;
      started_at: string;
      updated_at: string;
      last_action?: string;
      completed_steps_count: number;
    }>
  > {
    await this.init();
    const runsDir = getRunsDir();
    if (!fs.existsSync(runsDir)) return [];

    const entries = await fsp.readdir(runsDir, { withFileTypes: true });
    const results: Array<{
      run_id: string;
      goal: string;
      status: RunStatus;
      workspace: string;
      started_at: string;
      updated_at: string;
      last_action?: string;
      completed_steps_count: number;
    }> = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const runJsonPath = path.join(runsDir, entry.name, "run.json");
        if (fs.existsSync(runJsonPath)) {
          try {
            const raw = await fsp.readFile(runJsonPath, "utf-8");
            const r: RunMetadata = JSON.parse(raw);
            if (!options?.status || r.status === options.status) {
              results.push({
                run_id: r.run_id,
                goal: r.original_goal,
                status: r.status,
                workspace: r.workspace,
                started_at: r.started_at,
                updated_at: r.updated_at,
                last_action: typeof r.current_action === "string" ? r.current_action : r.current_action?.title,
                completed_steps_count: r.completed_steps.length,
              });
            }
          } catch {}
        }
      }
    }

    results.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    const limit = options?.limit ?? 50;
    return results.slice(0, limit);
  }

  /**
   * Get full details of a run.
   */
  public async getRun(
    runId: string,
    options?: {
      include_events?: boolean;
      event_limit?: number;
    }
  ): Promise<{
    run: RunMetadata;
    checkpoint?: Checkpoint;
    events?: ActivityEvent[];
    summary_markdown: string;
  }> {
    await this.init();
    const runDir = getRunDirPath(runId);
    const runJsonPath = path.join(runDir, "run.json");
    if (!fs.existsSync(runJsonPath)) {
      throw new Error(`Run "${runId}" not found in persistent store.`);
    }

    const run: RunMetadata = JSON.parse(await fsp.readFile(runJsonPath, "utf-8"));
    let checkpoint: Checkpoint | undefined = undefined;
    const chkPath = path.join(runDir, "checkpoint.json");
    if (fs.existsSync(chkPath)) {
      try {
        checkpoint = JSON.parse(await fsp.readFile(chkPath, "utf-8"));
      } catch {}
    }

    let summaryMarkdown = "";
    const sumPath = path.join(runDir, "summary.md");
    if (fs.existsSync(sumPath)) {
      summaryMarkdown = await fsp.readFile(sumPath, "utf-8");
    } else {
      summaryMarkdown = generateRunSummaryMarkdown(run);
    }

    let events: ActivityEvent[] | undefined = undefined;
    if (options?.include_events) {
      const readRes = await this.readRunEvents(runId, 0, options.event_limit || 100);
      events = readRes.events;
    }

    return {
      run,
      checkpoint,
      events,
      summary_markdown: summaryMarkdown,
    };
  }

  /**
   * Read events from a run's append-only events.jsonl with cursor pagination.
   */
  public async readRunEvents(
    runId?: string,
    cursor = 0,
    limit = 50
  ): Promise<{
    run_id: string;
    events: ActivityEvent[];
    cursor: number;
    next_cursor: number;
    has_more: boolean;
    total_events: number;
  }> {
    await this.init();
    const targetId = runId || this.activeRun?.run_id;
    if (!targetId) {
      return {
        run_id: "",
        events: [],
        cursor,
        next_cursor: cursor,
        has_more: false,
        total_events: 0,
      };
    }

    const eventsFile = path.join(getRunDirPath(targetId), "events.jsonl");
    if (!fs.existsSync(eventsFile)) {
      return {
        run_id: targetId,
        events: [],
        cursor,
        next_cursor: cursor,
        has_more: false,
        total_events: 0,
      };
    }

    const fileStream = fs.createReadStream(eventsFile, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    const matchedEvents: ActivityEvent[] = [];
    let totalCount = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      totalCount++;
      try {
        const ev: ActivityEvent = JSON.parse(line);
        if (ev.seq > cursor) {
          if (matchedEvents.length < limit) {
            matchedEvents.push(ev);
          }
        }
      } catch {}
    }

    const nextCursor = matchedEvents.length > 0 ? matchedEvents[matchedEvents.length - 1].seq : cursor;
    const hasMore = matchedEvents.length === limit;

    return {
      run_id: targetId,
      events: matchedEvents,
      cursor,
      next_cursor: nextCursor,
      has_more: hasMore,
      total_events: totalCount,
    };
  }
}

export const runManager = new RunManager();
