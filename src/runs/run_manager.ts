import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import os from "node:os";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import {
  getServerRoot,
  getPersistentDataRoot,
  getRunsDir,
  getStateDir,
  getActiveRunPath,
  getRunDirPath,
  getArchivesDir,
  ensureDirectoriesExist,
  getPersistentDiskUsageBytes,
} from "../storage/paths.js";
import {
  atomicWriteJson,
  atomicWriteFile,
  sanitizeObject,
  generateRunSummaryMarkdown,
  summarizeRunResources,
  deriveTaskIdentity,
  computeRunMatchScore,
  slugify,
  canonicalArtifactKey,
  isInternalRun,
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
  RunCandidate,
  FindRunsResult,
  RunResourceSummary,
  RunIndexItem,
  RunIndexSummary,
} from "./types.js";

export class RunManager {
  private activeRun: RunMetadata | null = null;
  private initialized = false;
  private initializing = false;
  private serverInstanceId = `srv_${process.pid}_${Date.now()}`;
  private writeQueue: Promise<void> = Promise.resolve();
  private cachedIndex: RunIndexSummary | null = null;
  public currentAcceptanceInvocationId: string | null = null;

  public invalidateIndexCache(): void {
    this.cachedIndex = null;
  }

  private queueWrite(fn: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(fn, fn);
    return this.writeQueue;
  }

  constructor() {}

  /**
   * Initialize run manager on server startup.
   * Scans all runs and detects interrupted runs from previous process crashes or computer restarts.
   */
  public async init(): Promise<void> {
    if (this.initialized || this.initializing) return;
    this.initializing = true;
    try {
      await ensureDirectoriesExist();

      const runsDir = getRunsDir();
      if (fs.existsSync(runsDir)) {
      try {
        const entries = await fsp.readdir(runsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const runJsonPath = path.join(runsDir, entry.name, "run.json");
            if (fs.existsSync(runJsonPath)) {
              try {
                const runRaw = await fsp.readFile(runJsonPath, "utf-8");
                const runData: RunMetadata = JSON.parse(runRaw);

                // If run was left "running" by a previous server PID:
                if (runData.status === "running" && runData.server_pid !== process.pid) {
                  if (isInternalRun(runData)) {
                    runData.status = "completed";
                    runData.internal_test = true;
                    runData.run_kind = "internal_test";
                    runData.current_action = null;
                  } else {
                    runData.status = "interrupted";
                    runData.warnings.push(
                      "Server process ended abruptly while run was in progress. Marked as interrupted on startup."
                    );
                  }
                  runData.updated_at = new Date().toISOString();

                  await atomicWriteJson(runJsonPath, runData);
                  await atomicWriteFile(
                    path.join(runsDir, entry.name, "summary.md"),
                    generateRunSummaryMarkdown(runData)
                  );
                } else if (isInternalRun(runData) && (!runData.internal_test || runData.run_kind !== "internal_test")) {
                  runData.internal_test = true;
                  runData.run_kind = "internal_test";
                  await atomicWriteJson(runJsonPath, runData);
                }
              } catch {}
            }
          }
        }
        await this.pruneInternalRuns({ maxRetain: 50 }).catch(() => {});
      } catch (err: any) {
        console.warn(`[VerityRunManager] Failed scanning runs on startup: ${err.message}`);
      }
    }

    // Inspect active run pointer
    const activePointerPath = getActiveRunPath();
    if (fs.existsSync(activePointerPath)) {
      try {
        const raw = await fsp.readFile(activePointerPath, "utf-8");
        const pointer: ActiveRunPointer = JSON.parse(raw);

        const runJsonPath = path.join(getRunDirPath(pointer.run_id), "run.json");
        if (fs.existsSync(runJsonPath)) {
          const runRaw = await fsp.readFile(runJsonPath, "utf-8");
          const runData: RunMetadata = JSON.parse(runRaw);

          if (pointer.status === "running" && pointer.server_pid !== process.pid) {
            pointer.status = "interrupted";
            pointer.updated_at = new Date().toISOString();
            await atomicWriteJson(activePointerPath, pointer);
          } else if (pointer.status === "running") {
            this.activeRun = runData;
          }
        }
      } catch (err: any) {
        console.warn(`[VerityRunManager] Failed inspecting prior active run pointer: ${err.message}`);
      }
    }

    activityStream.subscribe((event) => this.appendActivityEvent(event));
    this.initialized = true;
    } finally {
      this.initializing = false;
    }
  }

  public getActiveRun(): RunMetadata | null {
    return this.activeRun;
  }

  public setActiveRun(run: RunMetadata | null): void {
    this.activeRun = run;
  }

  public generateRunId(): string {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 6);
    return `run_${dateStr}_${rand}`;
  }

  /**
   * Find runs across all conversations using multi-signal ranking.
   * Distinguishes high-confidence matches and detects ambiguous run candidates.
   */
  public async findRuns(options: {
    query?: string;
    workspace?: string;
    project_key?: string;
    task_key?: string;
    statuses?: RunStatus[];
    limit?: number;
    include_internal_tests?: boolean;
  }): Promise<FindRunsResult> {
    await this.init();

    const runsDir = getRunsDir();
    if (!fs.existsSync(runsDir)) {
      return {
        query: options.query || "",
        candidates: [],
        is_ambiguous: false,
        recommended_action: "none_found",
      };
    }

    const entries = await fsp.readdir(runsDir, { withFileTypes: true });
    const candidates: RunCandidate[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const runJsonPath = path.join(runsDir, entry.name, "run.json");
        if (fs.existsSync(runJsonPath)) {
          try {
            const raw = await fsp.readFile(runJsonPath, "utf-8");
            const runData: RunMetadata = JSON.parse(raw);

            // Filter out internal test runs unless explicitly requested
            const isInternal = isInternalRun(runData);
            if (isInternal && !options.include_internal_tests) {
              continue;
            }

            // Status normalization
            let effectiveStatus: RunStatus = runData.status;
            if (runData.status === "running" && runData.server_pid && runData.server_pid !== process.pid) {
              effectiveStatus = isInternal ? "completed" : "interrupted";
            }
            const unresolvedDebt = (runData.cleanup_debt || []).filter((d) => !d.resolved).length;
            if (runData.status === "needs_cleanup" || (effectiveStatus === "completed" && unresolvedDebt > 0)) {
              effectiveStatus = "needs_cleanup";
            }

            // Filter by requested status if specified
            if (options.statuses && options.statuses.length > 0 && !options.statuses.includes(effectiveStatus)) {
              continue;
            }

            const score = computeRunMatchScore(runData, options.query || "", {
              workspaceFilter: options.workspace,
              projectKeyFilter: options.project_key,
              taskKeyFilter: options.task_key,
            });

            if (score.match_percentage > 0) {
              const activePhase = runData.phases.find((p) => p.status === "in_progress")?.title;
              candidates.push({
                run_id: runData.run_id,
                match_percentage: score.match_percentage,
                confidence: score.confidence,
                status: effectiveStatus,
                project_key: runData.project_key,
                task_key: runData.task_key,
                workspace: runData.workspace,
                original_goal: runData.original_goal,
                current_phase: activePhase,
                evidence: score.evidence,
                match_details: score.match_details,
                updated_at: runData.updated_at,
                started_at: runData.started_at,
                completed_steps_count: runData.completed_steps.length,
              });
            }
          } catch {}
        }
      }
    }

    // Sort by match_percentage descending, then recency
    candidates.sort((a, b) => {
      if (b.match_percentage !== a.match_percentage) {
        return b.match_percentage - a.match_percentage;
      }
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });

    const limit = options.limit ?? 20;
    const truncated = candidates.slice(0, limit);

    // Ambiguity Detection Guard
    let is_ambiguous = false;
    let ambiguity_reason: string | undefined = undefined;
    let recommended_action: "adopt_top_match" | "ask_user_choice" | "start_new_run" | "none_found" = "none_found";

    if (truncated.length === 0) {
      recommended_action = "none_found";
    } else if (
      truncated.length >= 2 &&
      truncated[0].match_percentage >= 50 &&
      truncated[0].match_percentage - truncated[1].match_percentage <= 12
    ) {
      is_ambiguous = true;
      ambiguity_reason = `AMBIGUOUS_RUN_MATCH: Top matching candidates "${truncated[0].run_id}" (${truncated[0].match_percentage}%) and "${truncated[1].run_id}" (${truncated[1].match_percentage}%) have closely competing scores. Ask the user which task to adopt.`;
      recommended_action = "ask_user_choice";
    } else if (truncated[0].match_percentage >= 45) {
      is_ambiguous = false;
      recommended_action = "adopt_top_match";
    } else {
      is_ambiguous = false;
      recommended_action = "start_new_run";
    }

    return {
      query: options.query || "",
      candidates: truncated,
      top_match: truncated[0],
      is_ambiguous,
      ambiguity_reason,
      recommended_action,
    };
  }

  /**
   * Adopt a specific durable run from disk as the active run in the current session.
   */
  public async adoptRun(
    runId: string,
    conversationId?: string
  ): Promise<{
    run: RunMetadata;
    summary_markdown: string;
  }> {
    await this.init();
    await this.writeQueue;

    const runDir = getRunDirPath(runId);
    const runJsonPath = path.join(runDir, "run.json");
    if (!fs.existsSync(runJsonPath)) {
      throw new Error(`Run "${runId}" not found in persistent store (${runDir}).`);
    }

    const runData: RunMetadata = JSON.parse(await fsp.readFile(runJsonPath, "utf-8"));
    const resJsonPath = path.join(runDir, "resources.json");
    if (fs.existsSync(resJsonPath)) {
      try {
        const resData = JSON.parse(await fsp.readFile(resJsonPath, "utf-8"));
        if (Array.isArray(resData.browser_sessions)) runData.browser_sessions = resData.browser_sessions;
        if (Array.isArray(resData.process_sessions)) runData.process_sessions = resData.process_sessions;
        if (Array.isArray(resData.temporary_files)) runData.temporary_files = resData.temporary_files;
        if (Array.isArray(resData.worktrees)) runData.worktrees = resData.worktrees;
        if (Array.isArray(resData.cleanup_debt)) runData.cleanup_debt = resData.cleanup_debt;
      } catch {}
    }

    if (this.activeRun && this.activeRun.run_id === runId) {
      if (this.activeRun.browser_sessions.length > runData.browser_sessions.length) runData.browser_sessions = this.activeRun.browser_sessions;
      if (this.activeRun.process_sessions.length > runData.process_sessions.length) runData.process_sessions = this.activeRun.process_sessions;
      if (this.activeRun.temporary_files.length > runData.temporary_files.length) runData.temporary_files = this.activeRun.temporary_files;
      if (this.activeRun.worktrees.length > runData.worktrees.length) runData.worktrees = this.activeRun.worktrees;
      if (this.activeRun.cleanup_debt.length > runData.cleanup_debt.length) runData.cleanup_debt = this.activeRun.cleanup_debt;
    }

    const now = new Date().toISOString();

    runData.adopted_at = now;
    runData.updated_at = now;

    if (conversationId) {
      runData.associated_conversation_ids = runData.associated_conversation_ids || [];
      if (!runData.associated_conversation_ids.includes(conversationId)) {
        runData.associated_conversation_ids.push(conversationId);
      }
    }

    this.activeRun = runData;

    await atomicWriteJson(runJsonPath, runData);
    const summaryMarkdown = generateRunSummaryMarkdown(runData);
    await atomicWriteFile(path.join(runDir, "summary.md"), summaryMarkdown);

    // Update active run pointer
    const pointer: ActiveRunPointer = {
      run_id: runData.run_id,
      status: runData.status,
      project_key: runData.project_key,
      task_key: runData.task_key,
      last_checkpoint: runData.last_checkpoint?.timestamp || now,
      workspace: runData.workspace,
      started_at: runData.started_at,
      updated_at: now,
      server_pid: process.pid,
      server_instance_id: this.serverInstanceId,
      heartbeat_at: now,
    };
    await atomicWriteJson(getActiveRunPath(), pointer);

    activityStream.emit({
      type: "plan",
      title: `Adopted durable run: ${runId}`,
      display_title: `Run adopted: ${runData.task_key || runId}`,
      purpose: `Adopted run across chat sessions for goal: ${runData.original_goal.slice(0, 60)}`,
      status: runData.status === "running" ? "running" : "completed",
      details: { run_id: runId, project_key: runData.project_key, task_key: runData.task_key },
    });

    this.invalidateIndexCache();

    return {
      run: runData,
      summary_markdown: summaryMarkdown,
    };
  }

  /**
   * Start a new durable run.
   * Includes idempotency key protection and rapid-replay suppression.
   */
  public async startRun(options: {
    goal: string;
    workspace?: string;
    purpose?: string;
    phases?: Phase[];
    project_key?: string;
    task_key?: string;
    internal_test?: boolean;
    run_kind?: "user" | "internal_test";
    acceptance_invocation_id?: string;
    test_kind?: string;
    tags?: string[];
    idempotency_key?: string;
    conversation_id?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    run: RunMetadata;
    storage_path: string;
    monitor_url: string;
    ui_resource_uri: string;
    is_replayed?: boolean;
  }> {
    await this.init();

    const workspace = options.workspace || process.cwd();
    const now = new Date().toISOString();

    // 1. Idempotency Key check: if an existing run matches idempotency_key, return it
    if (options.idempotency_key) {
      const runs = await this.listRuns({ limit: 50 });
      for (const r of runs) {
        const runJsonPath = path.join(getRunDirPath(r.run_id), "run.json");
        if (fs.existsSync(runJsonPath)) {
          try {
            const existingRun: RunMetadata = JSON.parse(await fsp.readFile(runJsonPath, "utf-8"));
            if (existingRun.idempotency_key === options.idempotency_key) {
              this.activeRun = existingRun;
              return {
                run: existingRun,
                storage_path: getRunDirPath(existingRun.run_id),
                monitor_url: `http://localhost:${process.env.VERITY_PORT || 7980}/monitor`,
                ui_resource_uri: "ui://verity/activity-monitor",
                is_replayed: true,
              };
            }
          } catch {}
        }
      }
    }

    // 2. Rapid Replay Suppression: if active run was started in the last 15 seconds with identical goal
    if (
      this.activeRun &&
      this.activeRun.original_goal === options.goal &&
      (Date.now() - new Date(this.activeRun.started_at).getTime()) < 15000
    ) {
      return {
        run: this.activeRun,
        storage_path: getRunDirPath(this.activeRun.run_id),
        monitor_url: `http://localhost:${process.env.VERITY_PORT || 7980}/monitor`,
        ui_resource_uri: "ui://verity/activity-monitor",
        is_replayed: true,
      };
    }

    const runId = this.generateRunId();
    const serverRoot = getServerRoot();
    const runDir = getRunDirPath(runId);

    await fsp.mkdir(runDir, { recursive: true });

    // Derive normalized project_key, task_key, tags, and goal fingerprint
    const identity = deriveTaskIdentity(options.goal, workspace, {
      projectKey: options.project_key,
      taskKey: options.task_key,
      tags: options.tags,
    });

    const initialPhases: Phase[] =
      options.phases && options.phases.length > 0
        ? options.phases
        : [
            { id: "init", title: "Initialize & Inspect Environment", status: "completed" },
            { id: "execution", title: "Autonomous Goal Execution", status: "in_progress" },
            { id: "verification", title: "Verification & Integrity Audit", status: "pending" },
            { id: "cleanup", title: "Resource Cleanup", status: "pending" },
          ];

    const isInternal = Boolean(
      options.internal_test ||
      options.run_kind === "internal_test" ||
      isInternalRun({
        project_key: options.project_key || identity.project_key,
        task_key: options.task_key || identity.task_key,
        original_goal: options.goal,
      })
    );

    const run: RunMetadata = {
      run_id: runId,
      project_key: identity.project_key,
      task_key: identity.task_key,
      internal_test: isInternal,
      run_kind: options.run_kind || (isInternal ? "internal_test" : "user"),
      acceptance_invocation_id: options.acceptance_invocation_id || (this.currentAcceptanceInvocationId ? this.currentAcceptanceInvocationId : undefined),
      test_kind: options.test_kind,
      tags: identity.tags,
      goal_fingerprint: identity.goal_fingerprint,
      idempotency_key: options.idempotency_key,
      origin_conversation_id: options.conversation_id,
      associated_conversation_ids: options.conversation_id ? [options.conversation_id] : [],
      server_instance_id: this.serverInstanceId,
      heartbeat_at: now,
      started_at: now,
      updated_at: now,
      status: "running",
      original_goal: options.goal,
      current_goal: options.goal,
      workspace,
      server_root: serverRoot,
      current_action: null,
      last_completed_action: null,
      last_failed_action: null,
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
    await atomicWriteFile(path.join(runDir, "summary.md"), generateRunSummaryMarkdown(run));

    // Update active run pointer
    const pointer: ActiveRunPointer = {
      run_id: runId,
      status: "running",
      project_key: run.project_key,
      task_key: run.task_key,
      last_checkpoint: now,
      workspace,
      started_at: now,
      updated_at: now,
      server_pid: process.pid,
      server_instance_id: this.serverInstanceId,
      heartbeat_at: now,
    };
    await atomicWriteJson(getActiveRunPath(), pointer);

    // Emit activity event
    activityStream.emit({
      type: "plan",
      title: `Started durable run: ${runId}`,
      display_title: `Run started: [${run.task_key}] ${run.original_goal.slice(0, 45)}`,
      purpose: options.purpose || `Execute autonomous goal: ${options.goal}`,
      purpose_source: options.purpose ? "caller" : "tool_default",
      status: "running",
      details: {
        run_id: runId,
        project_key: run.project_key,
        task_key: run.task_key,
        workspace,
      },
    });

    this.invalidateIndexCache();

    return {
      run,
      storage_path: runDir,
      monitor_url: `http://localhost:${process.env.VERITY_PORT || 7980}/monitor`,
      ui_resource_uri: "ui://verity/activity-monitor",
    };
  }

  /**
   * Append an activity event immediately to the active run's events.jsonl.
   * Automatically tracks created browser sessions, background processes, worktrees, and temporary files.
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
    } else if (
      event.type === "action_completed" ||
      event.type === "failure" ||
      (event.type === "verification" && event.status === "verified")
    ) {
      if (event.type === "failure") {
        this.activeRun.last_failed_action = event;
        this.activeRun.failures.push(event.title || "Operation failed");
      } else {
        this.activeRun.last_completed_action = event;
      }
      this.activeRun.current_action = null;
      this.activeRun.current_purpose = undefined;
      this.activeRun.current_target = undefined;
    } else if (event.type === "warning") {
      this.activeRun.warnings.push(event.title || "Warning encountered");
    }

    // Automatic Resource & Cleanup Debt Lifecycle Hooks
    this.autoTrackResourcesFromEvent(event);
  }

  /**
   * Automatic resource tracking: inspects events to register and resolve resources.
   * Guarantees single canonical ID registration and transactional debt resolution.
   */
  private autoTrackResourcesFromEvent(event: ActivityEvent): void {
    if (!this.activeRun) return;
    let stateChanged = false;

    // 1. Browser Sessions (Canonical identity: session_id strictly)
    const isBrowserTool = Boolean(event.tool && event.tool.startsWith("browser_"));
    const bSessionId =
      event.browser_session_id ||
      (event.details?.session_id as string) ||
      (event.details?.sessionId as string) ||
      (isBrowserTool &&
      typeof event.target === "string" &&
      !event.target.includes("://") &&
      !event.target.startsWith(".") &&
      !event.target.startsWith("/") &&
      !event.target.endsWith(".png")
        ? event.target
        : undefined);

    if (bSessionId) {
      let tracked = this.activeRun.browser_sessions.find((b) => b.id === bSessionId);
      const urlCandidate =
        (event.details?.url as string) ||
        (typeof event.target === "string" &&
        (event.target.startsWith("http://") ||
          event.target.startsWith("https://") ||
          event.target.startsWith("data:") ||
          event.target.startsWith("file://"))
          ? event.target
          : undefined);

      if (!tracked && event.tool !== "browser_close") {
        tracked = {
          id: bSessionId,
          url: urlCandidate,
          created: event.timestamp,
          created_at: event.timestamp,
          updated_at: event.timestamp,
          status: "active",
          cleanup_required: true,
          active: true,
        };
        this.activeRun.browser_sessions.push(tracked);
        this.activeRun.cleanup_debt.push({
          id: `debt_browser_${bSessionId}`,
          type: "browser_session",
          resource_id: bSessionId,
          description: `Browser session "${bSessionId}"`,
          created_at: event.timestamp,
          resolved: false,
        });
        stateChanged = true;
      } else if (tracked) {
        const isClosing =
          event.tool === "browser_close" ||
          event.title?.toLowerCase().includes("browser_close") ||
          event.details?.action === "browser_close";

        if (isClosing) {
          tracked.active = false;
          tracked.status = "closed";
          tracked.cleanup_required = false;
          tracked.resolved_at = new Date().toISOString();
          tracked.updated_at = new Date().toISOString();

          // Resolve cleanup debt
          const debt = this.activeRun.cleanup_debt.find(
            (c) => c.type === "browser_session" && c.resource_id === bSessionId
          );
          if (debt && !debt.resolved) {
            debt.resolved = true;
            debt.resolved_at = new Date().toISOString();
            debt.resolution_reason = "browser_closed";
          }
          stateChanged = true;
        } else {
          // Navigation updates URL only, never creates second record
          if (urlCandidate && tracked.url !== urlCandidate) {
            tracked.url = urlCandidate;
            tracked.updated_at = event.timestamp;
            stateChanged = true;
          }
        }
      }
    }

    // 2. Process Sessions
    const isBrowserEvent = Boolean(event.tool && event.tool.startsWith("browser_"));
    const isProcessTool = Boolean(
      event.tool &&
        (event.tool.includes("process") || event.tool === "exec_command" || event.tool === "process_completed")
    );
    const pSessionId =
      !isBrowserEvent
        ? event.process_session_id ||
          (event.details?.process_id as string) ||
          (isProcessTool ? (event.details?.session_id as string) || (event.details?.sessionId as string) : undefined) ||
          (isProcessTool &&
          typeof event.target === "string" &&
          !event.target.startsWith("http") &&
          !event.target.endsWith(".png") &&
          !event.target.includes("://")
            ? event.target
            : undefined)
        : undefined;

    if (pSessionId) {
      let trackedProc = this.activeRun.process_sessions.find((p) => p.id === pSessionId);
      if (!trackedProc && event.tool !== "stop_process" && event.tool !== "kill_process") {
        trackedProc = {
          id: pSessionId,
          pid: (event.details?.pid as number) || undefined,
          command:
            typeof event.target === "string"
              ? event.target
              : (event.details?.command as string) || "background process",
          running: true,
          cleanup_required: true,
          started_at: event.timestamp,
        };
        this.activeRun.process_sessions.push(trackedProc);
        this.activeRun.cleanup_debt.push({
          id: `debt_process_${pSessionId}`,
          type: "process_session",
          resource_id: pSessionId,
          description: `Background process "${pSessionId}"`,
          created_at: event.timestamp,
          resolved: false,
        });
        stateChanged = true;
      } else if (trackedProc) {
        const isEnded =
          event.tool === "stop_process" ||
          event.tool === "kill_process" ||
          event.tool === "process_completed" ||
          (event.tool === "exec_command" && (event.type === "action_completed" || event.type === "failure")) ||
          event.title?.toLowerCase().includes("stopping process") ||
          event.title?.toLowerCase().includes("process completed") ||
          event.title?.toLowerCase().includes("process exit") ||
          event.details?.status === "completed" ||
          event.details?.status === "failed" ||
          typeof event.details?.exit_code === "number" ||
          typeof event.details?.exitCode === "number";

        if (isEnded) {
          trackedProc.running = false;
          trackedProc.cleanup_required = false;
          trackedProc.completed_at = event.timestamp;
          if (typeof event.details?.exit_code === "number") {
            trackedProc.exit_code = event.details.exit_code;
          } else if (typeof event.details?.exitCode === "number") {
            trackedProc.exit_code = event.details.exitCode;
          }
          const debt = this.activeRun.cleanup_debt.find(
            (c) => c.type === "process_session" && c.resource_id === pSessionId
          );
          if (debt && !debt.resolved) {
            debt.resolved = true;
            debt.resolved_at = new Date().toISOString();
            debt.resolution_reason =
              event.tool === "stop_process" || event.tool === "kill_process"
                ? "process_killed"
                : "process_completed";
          }
          stateChanged = true;
        }
      }
    }

    // 3. Temporary Test Screenshot / Artifact Files
    const isArtifactTool =
      event.tool === "desktop_screenshot" ||
      event.tool === "screenshot_desktop" ||
      event.tool === "browser_screenshot" ||
      event.tool === "browser_pdf" ||
      event.tool === "browser_trace_stop";

    if (
      (event.type === "action_completed" || event.type === "verification") &&
      isArtifactTool
    ) {
      const outputPath =
        (event.details?.resolved_path as string) ||
        (event.details?.output_path as string) ||
        (event.details?.filePath as string) ||
        (event.details?.path as string) ||
        (typeof event.evidence === "object" && event.evidence
          ? (event.evidence as any).output_path as string ||
            (event.evidence as any).resolvedPath as string ||
            (event.evidence as any).filePath as string
          : undefined) ||
        (typeof event.target === "object" && event.target
          ? (event.target as any).resolvedPath || (event.target as any).outputPath
          : undefined) ||
        (typeof event.target === "string" &&
        (event.target.endsWith(".png") || event.target.endsWith(".pdf") || event.target.endsWith(".zip"))
          ? event.target
          : undefined);

      if (outputPath) {
        const explicitRole = (event.details?.artifact_role as any) || (event.details?.role as any);
        const sha256 =
          (event.details?.sha256 as string) ||
          (typeof event.evidence === "object" && event.evidence ? (event.evidence as any).sha256 as string : undefined);
        const bytes =
          (event.details?.bytes as number) ||
          (typeof event.evidence === "object" && event.evidence ? (event.evidence as any).bytes as number : undefined);
        const width =
          (event.details?.width as number) ||
          (typeof event.evidence === "object" && event.evidence ? (event.evidence as any).width as number : undefined);
        const height =
          (event.details?.height as number) ||
          (typeof event.evidence === "object" && event.evidence ? (event.evidence as any).height as number : undefined);
        const browserSessionId =
          event.browser_session_id || (event.details?.session_id as string);

        this.upsertArtifact({
          path: outputPath,
          tool: event.tool,
          purpose: event.purpose || event.title,
          artifact_role: explicitRole,
          sha256,
          bytes,
          width,
          height,
          browser_session_id: browserSessionId,
        });
        stateChanged = true;
      }
    }

    // 4. File Deletion -> Cleanup Debt Resolution
    if (event.tool === "delete_file" && (event.type === "action_completed" || event.type === "verification")) {
      const deletedPath =
        typeof event.target === "string"
          ? event.target
          : (event.details?.file_path as string) || (event.details?.path as string);
      if (deletedPath) {
        const canonicalDel = canonicalArtifactKey(deletedPath);
        for (const tf of this.activeRun.temporary_files) {
          if (canonicalArtifactKey(tf.resolved_path || tf.path) === canonicalDel) {
            tf.exists = false;
            tf.deleted = true;
            tf.cleanup_required = false;
            tf.deleted_at = event.timestamp;
            stateChanged = true;
          }
        }
        for (const c of this.activeRun.cleanup_debt) {
          if (c.type === "temporary_file" && c.path && canonicalArtifactKey(c.path) === canonicalDel) {
            if (!c.resolved) {
              c.resolved = true;
              c.resolved_at = new Date().toISOString();
              c.resolution_reason = "artifact_deleted";
              stateChanged = true;
            }
          }
        }
      }
    }

    // 5. Worktrees
    if (event.tool === "enter_worktree" && event.type === "action_completed") {
      const wtPath = (event.details?.worktree_path as string) || (event.target as string);
      const wtBranch = (event.details?.branch as string) || "worktree-branch";
      if (wtPath && !this.activeRun.worktrees.some((w) => path.resolve(w.path) === path.resolve(wtPath))) {
        this.activeRun.worktrees.push({
          path: wtPath,
          branch: wtBranch,
          cleanup_required: true,
          created_at: event.timestamp,
        });
        this.activeRun.cleanup_debt.push({
          id: `debt_wt_${Buffer.from(wtPath).toString("hex").slice(0, 8)}`,
          type: "worktree",
          path: wtPath,
          description: `Git worktree at "${wtPath}"`,
          created_at: event.timestamp,
          resolved: false,
        });
        stateChanged = true;
      }
    } else if (event.tool === "exit_worktree" && event.type === "action_completed") {
      const wtPath = (event.details?.worktree_path as string) || (event.target as string);
      if (wtPath) {
        const resolvedWt = path.resolve(wtPath);
        for (const w of this.activeRun.worktrees) {
          if (path.resolve(w.path) === resolvedWt) {
            w.cleanup_required = false;
            stateChanged = true;
          }
        }
        const debt = this.activeRun.cleanup_debt.find(
          (c) => c.type === "worktree" && c.path && path.resolve(c.path) === resolvedWt
        );
        if (debt && !debt.resolved) {
          debt.resolved = true;
          debt.resolved_at = new Date().toISOString();
          debt.resolution_reason = "worktree_removed";
          stateChanged = true;
        }
      }
    }

    if (stateChanged) {
      const runDir = getRunDirPath(this.activeRun.run_id);
      const resSnapshot = {
        browser_sessions: [...this.activeRun.browser_sessions],
        process_sessions: [...this.activeRun.process_sessions],
        temporary_files: [...this.activeRun.temporary_files],
        worktrees: [...this.activeRun.worktrees],
        cleanup_debt: [...this.activeRun.cleanup_debt],
      };
      const runSnapshot = { ...this.activeRun };
      this.queueWrite(async () => {
        await atomicWriteJson(path.join(runDir, "resources.json"), resSnapshot).catch(() => {});
        await atomicWriteJson(path.join(runDir, "run.json"), runSnapshot).catch(() => {});
        await atomicWriteFile(path.join(runDir, "summary.md"), generateRunSummaryMarkdown(runSnapshot)).catch(() => {});
      });
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
        project_key: runData.project_key,
        task_key: runData.task_key,
        last_checkpoint: now,
        workspace: runData.workspace,
        started_at: runData.started_at,
        updated_at: now,
        server_pid: process.pid,
        server_instance_id: this.serverInstanceId,
        heartbeat_at: now,
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

    this.invalidateIndexCache();

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
   * Idempotently upsert a tracked temporary artifact keyed strictly by canonical resolved path.
   * Guarantees:
   * 1 canonical path -> 1 temporary_files entry
   * 1 temporary_files entry -> 1 cleanup_debt entry
   * Merges incoming metadata across multiple instrumentation hooks.
   */
  public upsertArtifact(options: {
    path: string;
    resolved_path?: string;
    tool?: string;
    purpose?: string;
    role?: "temporary_test" | "user_output" | "persistent_project_file";
    artifact_role?: "temporary_test" | "user_output" | "persistent_project_file";
    cleanup_required?: boolean;
    sha256?: string;
    browser_session_id?: string;
    bytes?: number;
    width?: number;
    height?: number;
  }): TrackedTemporaryFile | undefined {
    if (!this.activeRun) return undefined;

    const outputPath = options.path;
    const resolvedPath = path.resolve(options.resolved_path || outputPath);
    const canonicalKey = canonicalArtifactKey(resolvedPath);
    const now = new Date().toISOString();

    const explicitRole = options.artifact_role || options.role;
    const bName = path.basename(outputPath);
    const role: "temporary_test" | "user_output" | "persistent_project_file" =
      explicitRole ||
      (bName.startsWith(".") ||
      outputPath.toLowerCase().includes("test") ||
      outputPath.toLowerCase().includes("temp") ||
      outputPath.toLowerCase().includes("tmp") ||
      resolvedPath.startsWith(os.tmpdir())
        ? "temporary_test"
        : "user_output");

    const cleanupRequired =
      options.cleanup_required !== undefined ? options.cleanup_required : role === "temporary_test";

    // 1. Look for existing artifact by canonical path
    let existing = this.activeRun.temporary_files.find(
      (f) => canonicalArtifactKey(f.resolved_path || f.path) === canonicalKey
    );

    if (existing) {
      if (options.tool && !existing.tool) existing.tool = options.tool;
      if (options.sha256 && !existing.sha256) existing.sha256 = options.sha256;
      if (options.purpose && !existing.purpose) existing.purpose = options.purpose;
      if (options.browser_session_id && !existing.browser_session_id) {
        existing.browser_session_id = options.browser_session_id;
      }
      if (typeof options.bytes === "number" && typeof existing.bytes !== "number") existing.bytes = options.bytes;
      if (typeof options.width === "number" && typeof existing.width !== "number") existing.width = options.width;
      if (typeof options.height === "number" && typeof existing.height !== "number") existing.height = options.height;
      if (explicitRole) {
        existing.role = role;
        existing.artifact_role = role;
      }
      existing.exists = true;
      existing.deleted = false;
      if (options.cleanup_required !== undefined) {
        existing.cleanup_required = cleanupRequired;
      }
    } else {
      const artifactId = `artifact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      existing = {
        id: artifactId,
        path: outputPath,
        resolved_path: resolvedPath,
        tool: options.tool,
        purpose: options.purpose,
        role,
        artifact_role: role,
        cleanup_required: cleanupRequired,
        created_at: now,
        exists: true,
        deleted: false,
        sha256: options.sha256,
        browser_session_id: options.browser_session_id,
        bytes: options.bytes,
        width: options.width,
        height: options.height,
      };
      this.activeRun.temporary_files.push(existing);
    }

    // 2. Stable cleanup debt deduplication
    const debtHash = crypto.createHash("sha256").update(canonicalKey).digest("hex").slice(0, 12);
    const stableDebtId = `debt_artifact_${debtHash}`;

    let existingDebt = this.activeRun.cleanup_debt.find(
      (c) => c.type === "temporary_file" && c.path && canonicalArtifactKey(c.path) === canonicalKey
    );

    if (cleanupRequired) {
      if (!existingDebt) {
        this.activeRun.cleanup_debt.push({
          id: stableDebtId,
          type: "temporary_file",
          path: resolvedPath,
          description: options.purpose || `Temporary artifact "${bName}"`,
          created_at: now,
          resolved: false,
        });
      } else if (existingDebt.resolved) {
        existingDebt.resolved = false;
        existingDebt.resolved_at = undefined;
        existingDebt.resolution_reason = undefined;
      }
    } else if (existingDebt && !existingDebt.resolved) {
      existingDebt.resolved = true;
      existingDebt.resolved_at = now;
      existingDebt.resolution_reason = "cleanup_not_required";
    }

    return existing;
  }

  /**
   * Track temporary files and add to cleanup debt (idempotent upsert).
   */
  public async trackTemporaryFile(
    filePath: string,
    purpose?: string,
    cleanupRequired = true,
    role: "temporary_test" | "user_output" | "persistent_project_file" = "temporary_test",
    extra?: Partial<TrackedTemporaryFile>
  ): Promise<void> {
    if (!this.activeRun) return;
    this.upsertArtifact({
      path: filePath,
      purpose,
      cleanup_required: cleanupRequired,
      role,
      artifact_role: role,
      ...extra,
    });

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
   * Resolve cleanup debt item(s) by id or path (defensively resolving all duplicates).
   */
  public async resolveCleanupDebt(idOrPath: string): Promise<void> {
    if (!this.activeRun) return;
    const canonicalTarget = canonicalArtifactKey(idOrPath);
    const now = new Date().toISOString();
    let changed = false;

    for (const c of this.activeRun.cleanup_debt) {
      const matches =
        c.id === idOrPath ||
        c.resource_id === idOrPath ||
        (c.path && (c.path === idOrPath || canonicalArtifactKey(c.path) === canonicalTarget));
      if (matches && !c.resolved) {
        c.resolved = true;
        c.resolved_at = now;
        c.resolution_reason = "explicit_resolve";
        changed = true;
      }
    }

    if (changed) {
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
  }

  /**
   * Reconcile real system state, persist verified updates to run.json/resources.json,
   * and resume run context.
   */
  public async resumeRun(runId?: string): Promise<RunResumeResult> {
    await this.init();
    await this.writeQueue;

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
        const incomplete = runs.find(
          (r) => r.status === "interrupted" || r.status === "running" || r.status === "needs_cleanup"
        );
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
    const resJsonPath = path.join(runDir, "resources.json");
    if (fs.existsSync(resJsonPath)) {
      try {
        const resData = JSON.parse(await fsp.readFile(resJsonPath, "utf-8"));
        if (Array.isArray(resData.browser_sessions)) run.browser_sessions = resData.browser_sessions;
        if (Array.isArray(resData.process_sessions)) run.process_sessions = resData.process_sessions;
        if (Array.isArray(resData.temporary_files)) run.temporary_files = resData.temporary_files;
        if (Array.isArray(resData.worktrees)) run.worktrees = resData.worktrees;
        if (Array.isArray(resData.cleanup_debt)) {
          run.cleanup_debt = resData.cleanup_debt;
        }
      } catch {}
    }
    if (this.activeRun && this.activeRun.run_id === targetId) {
      if (Array.isArray(this.activeRun.browser_sessions) && this.activeRun.browser_sessions.length > 0) {
        run.browser_sessions = this.activeRun.browser_sessions;
      }
      if (Array.isArray(this.activeRun.process_sessions) && this.activeRun.process_sessions.length > 0) {
        run.process_sessions = this.activeRun.process_sessions;
      }
      if (Array.isArray(this.activeRun.temporary_files) && this.activeRun.temporary_files.length > 0) {
        run.temporary_files = this.activeRun.temporary_files;
      }
      if (Array.isArray(this.activeRun.cleanup_debt) && this.activeRun.cleanup_debt.length > 0) {
        run.cleanup_debt = this.activeRun.cleanup_debt;
      }
      if (Array.isArray(this.activeRun.worktrees) && this.activeRun.worktrees.length > 0) {
        run.worktrees = this.activeRun.worktrees;
      }
    }
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
        gitBranch = execFileSync("git", ["branch", "--show-current"], {
          cwd: run.workspace,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();

        const statusOut = execFileSync("git", ["status", "--porcelain"], {
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

    // Reconciliation 3: Check live browser sessions in memory & update persisted state
    const liveBrowserSessions = browserManager.listSessions();
    const aliveBrowserIds = liveBrowserSessions.map((s) => s.id);
    for (const bs of run.browser_sessions) {
      if (!aliveBrowserIds.includes(bs.id)) {
        const wasActive = bs.active || bs.status === "active";
        bs.active = false;
        bs.status = "closed";
        bs.cleanup_required = false;
        if (!bs.resolved_at) bs.resolved_at = new Date().toISOString();
        bs.updated_at = new Date().toISOString();

        // Resolve cleanup debt
        const debt = run.cleanup_debt.find(
          (c) => c.type === "browser_session" && c.resource_id === bs.id
        );
        if (debt && !debt.resolved) {
          debt.resolved = true;
          debt.resolved_at = new Date().toISOString();
          debt.resolution_reason = "reconciliation_confirmed_missing";
        }
        if (wasActive) {
          warnings.push(`Browser session "${bs.id}" was active when interrupted but is no longer open.`);
        }
      }
    }

    // Reconciliation 4: Check live process sessions & update persisted state
    const liveProcessSessions = processManager.listSessions();
    const aliveProcessIds = liveProcessSessions.filter((s) => s.status === "running").map((s) => s.id);
    for (const ps of run.process_sessions) {
      if (!aliveProcessIds.includes(ps.id)) {
        const wasRunning = ps.running;
        ps.running = false;
        ps.cleanup_required = false;
        if (!ps.completed_at) ps.completed_at = new Date().toISOString();

        // Resolve cleanup debt
        const debt = run.cleanup_debt.find(
          (c) => (c.type === "process_session" || (c.type as string) === "background_process") && c.resource_id === ps.id
        );
        if (debt && !debt.resolved) {
          debt.resolved = true;
          debt.resolved_at = new Date().toISOString();
          debt.resolution_reason = "reconciliation_confirmed_missing";
        }
        if (wasRunning) {
          warnings.push(`Background process "${ps.id}" (PID ${ps.pid}) has terminated since interruption.`);
        }
      }
    }

    // Reconciliation 5: Check temporary artifacts on physical disk
    for (const tf of run.temporary_files) {
      const filePath = tf.resolved_path || tf.path;
      const canonicalPath = canonicalArtifactKey(filePath);
      const fileExists = fs.existsSync(filePath);
      if (!fileExists) {
        tf.exists = false;
        tf.deleted = true;
        tf.cleanup_required = false;
        if (!tf.deleted_at) tf.deleted_at = new Date().toISOString();

        for (const debt of run.cleanup_debt) {
          if (
            debt.type === "temporary_file" &&
            debt.path &&
            canonicalArtifactKey(debt.path) === canonicalPath
          ) {
            if (!debt.resolved) {
              debt.resolved = true;
              debt.resolved_at = new Date().toISOString();
              debt.resolution_reason = "reconciliation_confirmed_missing";
            }
          }
        }
      }
    }

    // Defensive check: any temporary_file debt whose path does not exist on disk must be resolved
    for (const debt of run.cleanup_debt) {
      if (debt.type === "temporary_file" && debt.path && !debt.resolved) {
        if (!fs.existsSync(debt.path)) {
          debt.resolved = true;
          debt.resolved_at = new Date().toISOString();
          debt.resolution_reason = "reconciliation_confirmed_missing";
        }
      }
    }

    // Determine in progress and remaining
    const inProgress = typeof run.current_action === "string" ? run.current_action : run.current_action?.title;
    const remainingSteps = run.pending_steps.length > 0 ? run.pending_steps : ["Complete remaining phases and cleanup"];

    // Update status to running now that it has been resumed
    run.status = "running";
    run.updated_at = new Date().toISOString();

    // CRITICAL: Persist reconciled state to run.json and resources.json immediately
    await atomicWriteJson(runJsonPath, run);
    await atomicWriteJson(path.join(runDir, "resources.json"), {
      browser_sessions: run.browser_sessions,
      process_sessions: run.process_sessions,
      temporary_files: run.temporary_files,
      worktrees: run.worktrees,
      cleanup_debt: run.cleanup_debt,
    });
    await atomicWriteFile(path.join(runDir, "summary.md"), generateRunSummaryMarkdown(run));

    // Update active pointer
    await atomicWriteJson(getActiveRunPath(), {
      run_id: run.run_id,
      status: "running",
      project_key: run.project_key,
      task_key: run.task_key,
      last_checkpoint: run.last_checkpoint?.timestamp || run.updated_at,
      workspace: run.workspace,
      started_at: run.started_at,
      updated_at: run.updated_at,
      server_pid: process.pid,
      server_instance_id: this.serverInstanceId,
      heartbeat_at: run.updated_at,
    });

    activityStream.emit({
      type: "action_started",
      title: `Resumed durable run: ${run.run_id}`,
      display_title: `Run resumed: [${run.task_key || run.run_id}]`,
      purpose: "Recover execution context and continue outstanding work",
      status: "running",
      details: { run_id: run.run_id, original_goal: run.original_goal, project_key: run.project_key, task_key: run.task_key },
    });

    activityStream.emit({
      type: "action_completed",
      title: `Run reconciliation complete: ${run.run_id}`,
      display_title: `Reconciliation complete [${run.task_key || run.run_id}]`,
      purpose: "Execution context recovered and reconciled",
      status: "completed",
      details: { run_id: run.run_id, status: run.status },
    });

    // Invariant: resume_run returns synchronously; current_action must be cleared before returning
    run.current_action = null;
    run.current_purpose = undefined;
    run.current_target = undefined;
    run.last_completed_action = `Run reconciliation complete: ${run.run_id}`;
    if (this.activeRun) {
      this.activeRun.current_action = null;
      this.activeRun.current_purpose = undefined;
      this.activeRun.current_target = undefined;
      this.activeRun.last_completed_action = `Run reconciliation complete: ${run.run_id}`;
    }
    await atomicWriteJson(runJsonPath, run);

    this.invalidateIndexCache();

    const instruction =
      `RESUMED RUN ${run.run_id} (Task: ${run.task_key || "default"}). ` +
      `Original Goal: "${run.original_goal}". ` +
      `Completed work: [${run.completed_steps.join(", ")}]. ` +
      (inProgress ? `Interrupted during: "${inProgress}". Verify state before retrying. ` : "") +
      `Outstanding work: [${remainingSteps.join(", ")}]. ` +
      `Cleanup debt remaining: ${run.cleanup_debt.filter((c) => !c.resolved).length} items.`;

    const liveActiveBrowsers = (run.browser_sessions || []).filter(
      (b) => b.active === true && b.status === "active"
    );
    const liveActiveProcesses = (run.process_sessions || []).filter((p) => p.running === true);
    const liveActiveWorktrees = (run.worktrees || []).filter((w) => w.cleanup_required !== false);
    const resourceSummary = summarizeRunResources(run);

    return {
      recovered_run_id: run.run_id,
      status: run.status,
      project_key: run.project_key,
      task_key: run.task_key,
      original_goal: run.original_goal,
      current_goal: run.current_goal || run.original_goal,
      workspace: run.workspace,
      completed_steps: run.completed_steps,
      in_progress_when_interrupted: inProgress,
      last_successful_action: run.completed_steps[run.completed_steps.length - 1],
      current_remaining_steps: remainingSteps,
      phases: run.phases,
      active_resources: {
        browser_sessions: liveActiveBrowsers,
        process_sessions: liveActiveProcesses,
        worktrees: liveActiveWorktrees,
      },
      resource_summary: resourceSummary,
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
   * Complete a run and audit cleanup debt and pending steps.
   */
  public async completeRun(
    runId?: string,
    options?: {
      status?: "completed" | "failed" | "abandoned";
      notes?: string;
      resolve_pending?: boolean;
      allow_cleanup_debt?: boolean;
      force?: boolean;
    }
  ): Promise<{
    run: RunMetadata;
    status: RunStatus;
    cleanup_warnings: string[];
    is_clean: boolean;
    error_code?: string;
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
    const requestedStatus = options?.status || "completed";
    let finalStatus: RunStatus = requestedStatus;
    const now = new Date().toISOString();

    // Guard: Prevent completing if pending steps remain (unless explicitly overridden)
    if (requestedStatus === "completed" && run.pending_steps.length > 0) {
      if (!options?.resolve_pending) {
        return {
          run,
          status: run.status,
          cleanup_warnings: [
            `RUN_HAS_PENDING_STEPS: Run cannot be marked completed while ${run.pending_steps.length} pending step(s) remain: [${run.pending_steps.join(", ")}]. Complete or remove pending steps, or set resolve_pending: true.`,
          ],
          is_clean: false,
          error_code: "RUN_HAS_PENDING_STEPS",
        };
      } else {
        // Automatically resolve pending steps
        for (const pending of run.pending_steps) {
          run.completed_steps.push(`[Resolved on completion] ${pending}`);
        }
        run.pending_steps = [];
      }
    }

    // Clear current action in flight
    run.current_action = null;
    run.current_purpose = undefined;
    run.current_target = undefined;

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

    // Guard: Enforce cleanup debt guard unless explicitly overridden
    if (requestedStatus === "completed" && (unresolvedDebt.length > 0 || cleanupWarnings.length > 0)) {
      if (!options?.allow_cleanup_debt && !options?.force) {
        return {
          run,
          status: run.status,
          cleanup_warnings: [
            `RUN_HAS_CLEANUP_DEBT: Run cannot be marked completed while ${unresolvedDebt.length} unresolved cleanup debt item(s) remain: [${unresolvedDebt.map((c) => `${c.type}:${c.path || c.resource_id}`).join(", ")}]. Resolve resources or set allow_cleanup_debt: true.`,
            ...cleanupWarnings,
          ],
          is_clean: false,
          error_code: "RUN_HAS_CLEANUP_DEBT",
        };
      }
      if (!options?.force) {
        finalStatus = "needs_cleanup";
      }
    }

    run.status = finalStatus;
    run.updated_at = now;
    if (options?.notes) {
      run.completed_steps.push(`Completion Note: ${options.notes}`);
    }

    // Normalize phases on finalization
    if (finalStatus === "completed") {
      run.phases = run.phases.map((p) => ({ ...p, status: "completed" }));
    } else if (finalStatus === "failed") {
      run.phases = run.phases.map((p) => {
        if (p.status === "in_progress") return { ...p, status: "failed" };
        if (p.status === "pending") return { ...p, status: "skipped" };
        return p;
      });
    } else if (finalStatus === "abandoned") {
      run.phases = run.phases.map((p) => {
        if (p.status === "in_progress" || p.status === "pending") return { ...p, status: "skipped" };
        return p;
      });
    }

    await atomicWriteJson(runJsonPath, run);
    await atomicWriteFile(path.join(runDir, "summary.md"), generateRunSummaryMarkdown(run));

    // Clear active pointer if this was active and is now terminal
    const activePointerPath = getActiveRunPath();
    if (fs.existsSync(activePointerPath)) {
      try {
        const raw = await fsp.readFile(activePointerPath, "utf-8");
        const ptr: ActiveRunPointer = JSON.parse(raw);
        if (ptr.run_id === targetId) {
          await fsp.unlink(activePointerPath).catch(() => {});
        }
      } catch {}
    }

    if (this.activeRun && this.activeRun.run_id === targetId) {
      this.activeRun = null;
    }

    activityStream.emit({
      type: "action_completed",
      title: `Run ${finalStatus}: ${targetId}`,
      display_title: `Run ${finalStatus} [${run.task_key || targetId}]`,
      status: finalStatus === "completed" ? "completed" : "failed",
      evidence: { cleanup_warnings: cleanupWarnings, final_status: finalStatus },
    });

    this.invalidateIndexCache();

    return {
      run,
      status: finalStatus,
      cleanup_warnings: cleanupWarnings,
      is_clean: cleanupWarnings.length === 0,
    };
  }

  /**
   * Synchronously compute normalized run index summary across persistent runs.
   * Applies identical orphan normalization and status recognition so that
   * diagnostics and list_runs never disagree.
   */
  public getNormalizedRunIndexSync(options?: { refresh?: boolean }): RunIndexSummary {
    if (this.cachedIndex && !options?.refresh) {
      return this.cachedIndex;
    }

    const runsDir = getRunsDir();
    if (!fs.existsSync(runsDir)) {
      const empty: RunIndexSummary = {
        total: 0,
        user_runs: 0,
        internal_test_runs: 0,
        internal_test_runs_running: 0,
        acceptance_run_leaks: 0,
        running_runs: 0,
        interrupted_runs: 0,
        needs_cleanup_runs: 0,
        completed_runs: 0,
        failed_runs: 0,
        abandoned_runs: 0,
        items: [],
      };
      this.cachedIndex = empty;
      return empty;
    }

    const entries = fs.readdirSync(runsDir, { withFileTypes: true });
    const items: RunIndexItem[] = [];

    let total = 0;
    let userRuns = 0;
    let internalTestRuns = 0;
    let internalTestRunsRunning = 0;
    let acceptanceRunLeaks = 0;
    let runningRuns = 0;
    let interruptedRuns = 0;
    let needsCleanupRuns = 0;
    let completedRuns = 0;
    let failedRuns = 0;
    let abandonedRuns = 0;

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const runJsonPath = path.join(runsDir, entry.name, "run.json");
        if (fs.existsSync(runJsonPath)) {
          try {
            const raw = fs.readFileSync(runJsonPath, "utf-8");
            const rData: RunMetadata = JSON.parse(raw);
            total++;

            const isInternal = isInternalRun(rData);
            if (isInternal) {
              internalTestRuns++;
            } else {
              userRuns++;
            }

            // Consistent status normalization
            let effectiveStatus: RunStatus = rData.status;

            // Orphan check: If left "running" by a previous PID
            if (rData.status === "running") {
              const isOrphan = rData.server_pid && rData.server_pid !== process.pid;
              if (isOrphan) {
                if (isInternal) {
                  effectiveStatus = "completed";
                } else {
                  effectiveStatus = "interrupted";
                }
              }
            }

            // Cleanup debt check: if status is needs_cleanup or if completed with unresolved debt
            const unresolvedDebt = (rData.cleanup_debt || []).filter((d) => !d.resolved).length;
            if (rData.status === "needs_cleanup") {
              effectiveStatus = "needs_cleanup";
            } else if (effectiveStatus === "completed" && unresolvedDebt > 0) {
              effectiveStatus = "needs_cleanup";
            }

            // Status buckets
            if (effectiveStatus === "running") {
              runningRuns++;
              if (isInternal) {
                internalTestRunsRunning++;
                if (rData.acceptance_invocation_id) {
                  if (!this.currentAcceptanceInvocationId || rData.acceptance_invocation_id !== this.currentAcceptanceInvocationId) {
                    acceptanceRunLeaks++;
                  }
                }
              }
            } else if (effectiveStatus === "interrupted") {
              interruptedRuns++;
            } else if (effectiveStatus === "needs_cleanup") {
              needsCleanupRuns++;
            } else if (effectiveStatus === "completed") {
              completedRuns++;
            } else if (effectiveStatus === "failed") {
              failedRuns++;
            } else if (effectiveStatus === "abandoned") {
              abandonedRuns++;
            }

            const activePhase =
              rData.phases?.find((p) => p.status === "in_progress")?.title ||
              rData.phases?.[0]?.title;

            items.push({
              run_id: rData.run_id,
              project_key: rData.project_key,
              task_key: rData.task_key,
              goal: rData.original_goal,
              status: effectiveStatus,
              workspace: rData.workspace,
              started_at: rData.started_at,
              updated_at: rData.updated_at,
              server_pid: rData.server_pid,
              server_instance_id: rData.server_instance_id,
              is_internal: isInternal,
              run_kind: isInternal ? "internal_test" : (rData.run_kind || "user"),
              cleanup_debt_unresolved: unresolvedDebt,
              last_action: typeof rData.current_action === "string" ? rData.current_action : rData.current_action?.title,
              current_phase: activePhase,
              completed_steps_count: (rData.completed_steps || []).length,
            });
          } catch {}
        }
      }
    }

    items.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    const summary: RunIndexSummary = {
      total,
      user_runs: userRuns,
      internal_test_runs: internalTestRuns,
      internal_test_runs_running: internalTestRunsRunning,
      acceptance_run_leaks: acceptanceRunLeaks,
      running_runs: runningRuns,
      interrupted_runs: interruptedRuns,
      needs_cleanup_runs: needsCleanupRuns,
      completed_runs: completedRuns,
      failed_runs: failedRuns,
      abandoned_runs: abandonedRuns,
      items,
    };

    this.cachedIndex = summary;
    return summary;
  }

  /**
   * Asynchronously compute normalized run index summary, ensuring init has run.
   */
  public async getNormalizedRunIndex(options?: { refresh?: boolean }): Promise<RunIndexSummary> {
    if (!this.initialized && !this.initializing) {
      await this.init();
    }
    return this.getNormalizedRunIndexSync(options);
  }

  /**
   * Safely maintain and clean up old internal test runs without ever touching real user runs.
   */
  public async maintenanceRuns(options?: {
    dry_run?: boolean;
    keep_latest?: number;
    older_than_days?: number;
    internal_tests_only?: boolean;
    mode?: "archive" | "delete";
  }): Promise<{
    dry_run: boolean;
    mode: "archive" | "delete";
    scanned_total: number;
    internal_total: number;
    user_runs_protected: number;
    eligible_count: number;
    processed_count: number;
    retained_count: number;
    candidates: Array<{ run_id: string; task_key?: string; updated_at: string; age_days: number }>;
    archive_directory: string;
    scanned_internal_total: number;
    protected_active_internal: number;
    eligible_historical_internal: number;
    retained_historical_internal: number;
    archived_internal: number;
    deleted_internal: number;
    remaining_internal_active_store: number;
    user_runs_affected: number;
    archive_candidates: number;
  }> {
    if (!this.initialized && !this.initializing) {
      await this.init();
    }
    const runsDir = getRunsDir();
    const dryRun = options?.dry_run !== false;
    const keepLatest = options?.keep_latest ?? 50;
    const olderThanDays = options?.older_than_days ?? 7;
    const mode = options?.mode || "archive";
    const internalArchiveDir = path.join(getArchivesDir(), "internal");

    if (!fs.existsSync(runsDir)) {
      return {
        dry_run: dryRun,
        mode,
        scanned_total: 0,
        internal_total: 0,
        user_runs_protected: 0,
        eligible_count: 0,
        processed_count: 0,
        retained_count: 0,
        candidates: [],
        archive_directory: internalArchiveDir,
        scanned_internal_total: 0,
        protected_active_internal: 0,
        eligible_historical_internal: 0,
        retained_historical_internal: 0,
        archived_internal: 0,
        deleted_internal: 0,
        remaining_internal_active_store: 0,
        user_runs_affected: 0,
        archive_candidates: 0,
      };
    }

    const entries = await fsp.readdir(runsDir, { withFileTypes: true });
    let scannedTotal = 0;
    let userRunsProtected = 0;
    let protectedActiveInternal = 0;
    const historicalInternalRuns: Array<{ dirName: string; run_id: string; task_key?: string; updated_at: string; age_days: number }> = [];

    const nowMs = Date.now();
    const cutoffMs = nowMs - (olderThanDays * 24 * 60 * 60 * 1000);

    for (const entry of entries) {
      if (entry.isDirectory()) {
        scannedTotal++;
        const runJsonPath = path.join(runsDir, entry.name, "run.json");
        if (fs.existsSync(runJsonPath)) {
          try {
            const raw = await fsp.readFile(runJsonPath, "utf-8");
            const runData: RunMetadata = JSON.parse(raw);
            const isInternal = isInternalRun(runData);

            if (!isInternal) {
              // STRICT PROTECTION: Real user runs are NEVER pruned or archived!
              userRunsProtected++;
              continue;
            }

            // In-flight guard: An active or currently running run must NEVER be archived or deleted
            if (runData.status === "running" || (this.activeRun && this.activeRun.run_id === (runData.run_id || entry.name))) {
              protectedActiveInternal++;
              continue;
            }

            const updatedStr = runData.updated_at || runData.started_at || new Date().toISOString();
            const updatedTime = new Date(updatedStr).getTime();
            const ageDays = Math.max(0, Math.floor((nowMs - updatedTime) / (24 * 60 * 60 * 1000)));

            historicalInternalRuns.push({
              dirName: entry.name,
              run_id: runData.run_id || entry.name,
              task_key: runData.task_key,
              updated_at: updatedStr,
              age_days: ageDays,
            });
          } catch {}
        }
      }
    }

    // Sort newest to oldest
    historicalInternalRuns.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    // Retention policy: Keep the `keepLatest` newest internal runs.
    // Beyond keepLatest, runs older than `olderThanDays` are eligible.
    // If olderThanDays is 0 or runs are older than cutoffMs, they are eligible.
    const beyondKeep = historicalInternalRuns.slice(keepLatest);
    const eligible = beyondKeep.filter((r) => olderThanDays <= 0 || new Date(r.updated_at).getTime() <= cutoffMs);

    const candidates = eligible.map((r) => ({
      run_id: r.run_id,
      task_key: r.task_key,
      updated_at: r.updated_at,
      age_days: r.age_days,
    }));

    let processedCount = 0;

    if (!dryRun && eligible.length > 0) {
      if (mode === "archive") {
        if (!fs.existsSync(internalArchiveDir)) {
          await fsp.mkdir(internalArchiveDir, { recursive: true });
        }
      }

      for (const r of eligible) {
        const srcPath = path.join(runsDir, r.dirName);
        try {
          if (mode === "archive") {
            const destPath = path.join(internalArchiveDir, r.dirName);
            try {
              await fsp.rename(srcPath, destPath);
            } catch {
              await fsp.cp(srcPath, destPath, { recursive: true });
              await fsp.rm(srcPath, { recursive: true, force: true });
            }
            processedCount++;
          } else if (mode === "delete") {
            await fsp.rm(srcPath, { recursive: true, force: true });
            processedCount++;
          }
        } catch (err: any) {
          console.warn(`[VerityRunManager] Failed ${mode} run ${r.dirName}: ${err.message}`);
        }
      }

      this.invalidateIndexCache();
    }

    const scannedInternalTotal = protectedActiveInternal + historicalInternalRuns.length;
    const eligibleHistoricalInternal = historicalInternalRuns.length;
    const retainedHistoricalInternal = dryRun
      ? (historicalInternalRuns.length - eligible.length)
      : (historicalInternalRuns.length - processedCount);
    const archivedInternal = mode === "archive" ? (dryRun ? eligible.length : processedCount) : 0;
    const deletedInternal = mode === "delete" ? (dryRun ? eligible.length : processedCount) : 0;
    const remainingInternalActiveStore = protectedActiveInternal + retainedHistoricalInternal;

    return {
      dry_run: dryRun,
      mode,
      scanned_total: scannedTotal,
      internal_total: scannedInternalTotal,
      user_runs_protected: userRunsProtected,
      eligible_count: eligible.length,
      processed_count: processedCount,
      retained_count: retainedHistoricalInternal,
      candidates,
      archive_directory: internalArchiveDir,
      scanned_internal_total: scannedInternalTotal,
      protected_active_internal: protectedActiveInternal,
      eligible_historical_internal: eligibleHistoricalInternal,
      retained_historical_internal: retainedHistoricalInternal,
      archived_internal: archivedInternal,
      deleted_internal: deletedInternal,
      remaining_internal_active_store: remainingInternalActiveStore,
      user_runs_affected: 0,
      archive_candidates: eligible.length,
    };
  }

  /**
   * Prunes old internal test runs to prevent accumulation while strictly preserving user runs.
   */
  public async pruneInternalRuns(options?: { maxRetain?: number; olderThanDays?: number }): Promise<{
    retained: number;
    pruned: number;
  }> {
    const res = await this.maintenanceRuns({
      dry_run: false,
      keep_latest: options?.maxRetain ?? 50,
      older_than_days: options?.olderThanDays ?? 7,
      mode: "archive",
    });
    return {
      retained: res.retained_count,
      pruned: res.processed_count,
    };
  }

  /**
   * List all persisted runs from <persistentDataRoot>/runs using normalized run index.
   */
  public async listRuns(options?: {
    status?: string;
    limit?: number;
    include_internal_tests?: boolean;
  }): Promise<RunIndexItem[]> {
    const index = await this.getNormalizedRunIndex();
    let items = index.items;

    if (options?.include_internal_tests === false) {
      items = items.filter((i) => !i.is_internal);
    }

    if (options?.status && options.status !== "all") {
      items = items.filter((i) => i.status === options.status);
    }

    if (options?.limit !== undefined) {
      items = items.slice(0, options.limit);
    }
    return items;
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
    resource_summary?: RunResourceSummary;
    summary_markdown: string;
  }> {
    await this.init();
    await this.writeQueue;
    const runDir = getRunDirPath(runId);
    const runJsonPath = path.join(runDir, "run.json");
    if (!fs.existsSync(runJsonPath)) {
      throw new Error(`Run "${runId}" not found in persistent store.`);
    }

    const run: RunMetadata = JSON.parse(await fsp.readFile(runJsonPath, "utf-8"));
    const resJsonPath = path.join(runDir, "resources.json");
    if (fs.existsSync(resJsonPath)) {
      try {
        const resData = JSON.parse(await fsp.readFile(resJsonPath, "utf-8"));
        if (Array.isArray(resData.browser_sessions)) run.browser_sessions = resData.browser_sessions;
        if (Array.isArray(resData.process_sessions)) run.process_sessions = resData.process_sessions;
        if (Array.isArray(resData.temporary_files)) run.temporary_files = resData.temporary_files;
        if (Array.isArray(resData.worktrees)) run.worktrees = resData.worktrees;
        if (Array.isArray(resData.cleanup_debt)) run.cleanup_debt = resData.cleanup_debt;
      } catch {}
    }

    if (this.activeRun && this.activeRun.run_id === runId) {
      run.current_action = this.activeRun.current_action;
      run.current_purpose = this.activeRun.current_purpose;
      run.current_target = this.activeRun.current_target;
      run.last_completed_action = this.activeRun.last_completed_action;
      run.last_failed_action = this.activeRun.last_failed_action;
      run.browser_sessions = this.activeRun.browser_sessions;
      run.process_sessions = this.activeRun.process_sessions;
      run.temporary_files = this.activeRun.temporary_files;
      run.worktrees = this.activeRun.worktrees;
      run.cleanup_debt = this.activeRun.cleanup_debt;
    }

    let checkpoint: Checkpoint | undefined = undefined;
    const chkPath = path.join(runDir, "checkpoint.json");
    if (fs.existsSync(chkPath)) {
      try {
        checkpoint = JSON.parse(await fsp.readFile(chkPath, "utf-8"));
      } catch {}
    }

    const summaryMarkdown = generateRunSummaryMarkdown(run);

    let events: ActivityEvent[] | undefined = undefined;
    if (options?.include_events) {
      const readRes = await this.readRunEvents(runId, 0, options.event_limit || 100);
      events = readRes.events;
    }

    return {
      run,
      checkpoint,
      events,
      resource_summary: summarizeRunResources(run),
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
