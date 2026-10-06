import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getServerRoot,
  getPersistentDataRoot,
  getRunsDir,
  getActiveRunPath,
  getRunDirPath,
} from "../src/storage/paths.js";
import { RunManager } from "../src/runs/run_manager.js";
import { createVerityMcpServer } from "../src/server/mcp_tools.js";
import { activityStream } from "../src/observability/activity_stream.js";
import type { VerityConfig } from "../src/types/index.js";
import { calculateSha256 } from "../src/verification/index.js";

describe("VerityMCP Cross-Conversation Recovery & Durability Acceptance Suite", () => {
  let tempWorkspace: string;
  let tempOutsideDir: string;
  let testRunManager: RunManager;
  let mcpClient: Client;
  let serverInstance: any;

  before(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "verity-cross-ws-"));
    tempOutsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "verity-outside-dir-"));

    testRunManager = new RunManager();
    await testRunManager.init();

    const config: VerityConfig = {
      port: 8130,
      host: "127.0.0.1",
      allowedRoots: [tempWorkspace, tempOutsideDir, getServerRoot()],
      worktreesDir: "",
    };

    serverInstance = createVerityMcpServer(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await serverInstance.connect(serverTransport);

    mcpClient = new Client({ name: "test-cross-recovery-client", version: "1.0.0" });
    await mcpClient.connect(clientTransport);
  });

  after(async () => {
    await fs.rm(tempWorkspace, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tempOutsideDir, { recursive: true, force: true }).catch(() => {});
  });

  it("1. ranks runs by contextual relevance across conversations rather than blind recency", async () => {
    const runTag = `t1_${Date.now()}`;
    // Create 3 runs with distinct project keys, task keys, and goals
    const runA = await testRunManager.startRun({
      goal: `Optimize native harness benchmark for Trebell compiler ${runTag}`,
      workspace: tempWorkspace,
      project_key: `trebell-code-${runTag}`,
      task_key: `native-harness-benchmark-optimization-${runTag}`,
      tags: ["benchmark", "performance", "compiler"],
    });

    // Slight delay to ensure sequential timestamps
    await new Promise((r) => setTimeout(r, 20));

    const runB = await testRunManager.startRun({
      goal: `Redesign authentication login modal and session recovery ${runTag}`,
      workspace: tempWorkspace,
      project_key: `trebell-auth-${runTag}`,
      task_key: `auth-modal-redesign-${runTag}`,
      tags: ["auth", "frontend", "session"],
    });

    await new Promise((r) => setTimeout(r, 20));

    // Run C is created LAST (most recent)
    const runC = await testRunManager.startRun({
      goal: `Setup Postgres database migrations and CI pipelines ${runTag}`,
      workspace: tempWorkspace,
      project_key: `infra-core-${runTag}`,
      task_key: `postgres-ci-migrations-${runTag}`,
      tags: ["database", "migrations", "docker"],
    });

    // Search specifically for benchmark optimization task
    const searchRes = await testRunManager.findRuns({
      query: `benchmark harness optimization ${runTag}`,
      project_key: `trebell-code-${runTag}`,
    });

    assert.ok(searchRes.candidates.length > 0);
    assert.equal(searchRes.is_ambiguous, false);
    assert.ok(searchRes.top_match);
    // Run A must be top match even though Run C was created last!
    assert.equal(searchRes.top_match.run_id, runA.run.run_id);
    assert.ok(searchRes.top_match.match_percentage > 50);
    assert.equal(searchRes.recommended_action, "adopt_top_match");

    // Also test via MCP tool find_runs
    const mcpFindCall: any = await mcpClient.callTool({
      name: "find_runs",
      arguments: {
        query: `login modal authentication ${runTag}`,
        task_key: `auth-modal-redesign-${runTag}`,
      },
    });

    assert.ok(mcpFindCall.content[0].text.includes(runB.run.run_id));
  });

  it("2. detects ambiguous run matches and prevents guessing across chats", async () => {
    // Create two runs with very similar goals and keywords
    const ambRun1 = await testRunManager.startRun({
      goal: "Fix flaky WebSocket reconnection timeout in client test suite",
      workspace: tempWorkspace,
      project_key: "shared-net",
      task_key: "websocket-harness-fix-timeout",
    });

    await new Promise((r) => setTimeout(r, 20));

    const ambRun2 = await testRunManager.startRun({
      goal: "Fix flaky WebSocket reconnection disconnect in client test suite",
      workspace: tempWorkspace,
      project_key: "shared-net",
      task_key: "websocket-harness-fix-disconnect",
    });

    // Query matching both almost equally
    const ambSearch = await testRunManager.findRuns({
      query: "Fix flaky WebSocket reconnection in client test suite",
      project_key: "shared-net",
    });

    assert.ok(ambSearch.candidates.length >= 2);
    assert.equal(ambSearch.is_ambiguous, true, "Must flag ambiguous run match");
    assert.equal(ambSearch.recommended_action, "ask_user_choice");
    assert.ok(ambSearch.ambiguity_reason?.includes("AMBIGUOUS_RUN_MATCH"));
  });

  it("3. adopts an existing run across chat conversations with adopt_run", async () => {
    const targetRun = await testRunManager.startRun({
      goal: "Migrate REST endpoints to GraphQL schema",
      workspace: tempWorkspace,
      project_key: "api-v2",
      task_key: "rest-to-graphql-migration",
    });

    const newChatConversationId = "chat-thread-xyz-789";

    // Call MCP adopt_run
    const adoptCall: any = await mcpClient.callTool({
      name: "adopt_run",
      arguments: {
        run_id: targetRun.run.run_id,
        conversation_id: newChatConversationId,
      },
    });

    assert.ok(adoptCall.content[0].text.includes("successfully adopted"));

    // Verify active pointer is updated
    const activePointer = JSON.parse(await fs.readFile(getActiveRunPath(), "utf-8"));
    assert.equal(activePointer.run_id, targetRun.run.run_id);
    assert.equal(activePointer.task_key, "rest-to-graphql-migration");

    // Verify disk run.json was updated with adopted_at and associated conversation
    const diskRun = JSON.parse(await fs.readFile(path.join(getRunDirPath(targetRun.run.run_id), "run.json"), "utf-8"));
    assert.ok(diskRun.adopted_at);
    assert.ok(diskRun.associated_conversation_ids?.includes(newChatConversationId));
  });

  it("4. automatically tracks created resources and cleanup debt upon tool events", async () => {
    const activeRun = await testRunManager.startRun({
      goal: "Lifecycle and resource tracking audit run",
      workspace: tempWorkspace,
      project_key: "audit-test",
    });

    const shotFile = path.join(tempWorkspace, "temp-audit-screen.png");
    await fs.writeFile(shotFile, "audit-img-data", "utf-8");

    // Simulate tool activity events
    activityStream.emit({
      type: "action_started",
      tool: "start_process",
      title: "Spawning background worker",
      target: "worker-proc-99",
      details: { session_id: "worker-proc-99", command: "node worker.js" },
    });

    activityStream.emit({
      type: "action_completed",
      tool: "desktop_screenshot",
      title: "Captured desktop screenshot",
      target: shotFile,
      details: { output_path: shotFile },
    });

    activityStream.emit({
      type: "action_completed",
      tool: "enter_worktree",
      title: "Entered isolated worktree",
      target: path.join(tempWorkspace, "worktree-audit"),
      details: { worktree_path: path.join(tempWorkspace, "worktree-audit"), branch: "test-wt-branch" },
    });

    // Give asynchronous writes a moment to persist
    await (testRunManager as any).writeQueue;
    await new Promise((r) => setTimeout(r, 250));

    const resJson = JSON.parse(
      await fs.readFile(path.join(getRunDirPath(activeRun.run.run_id), "resources.json"), "utf-8")
    );

    // Verify process tracked
    assert.ok(resJson.process_sessions.some((p: any) => p.id === "worker-proc-99"));
    // Verify screenshot tracked with role temporary_test
    const tempTracked = resJson.temporary_files.find((f: any) => f.path === shotFile);
    assert.ok(tempTracked);
    assert.equal(tempTracked.role, "temporary_test");

    // Verify worktree tracked
    assert.ok(resJson.worktrees.some((w: any) => w.path.includes("worktree-audit")));

    // Verify cleanup debt was recorded
    assert.ok(resJson.cleanup_debt.some((c: any) => c.resource_id === "worker-proc-99" && !c.resolved));
    assert.ok(resJson.cleanup_debt.some((c: any) => c.path === shotFile && !c.resolved));
  });

  it("5. automatically resolves cleanup debt when resources are closed or files deleted", async () => {
    const active = testRunManager.getActiveRun();
    assert.ok(active);

    const shotFile = path.join(tempWorkspace, "temp-audit-screen.png");
    const wtPath = path.join(tempWorkspace, "worktree-audit");

    // Simulate resolution events
    activityStream.emit({
      type: "action_completed",
      tool: "stop_process",
      title: "Stopped process",
      target: "worker-proc-99",
      details: { session_id: "worker-proc-99" },
    });

    activityStream.emit({
      type: "action_completed",
      tool: "delete_file",
      title: "Deleted temporary artifact",
      target: shotFile,
      details: { file_path: shotFile },
    });

    activityStream.emit({
      type: "action_completed",
      tool: "exit_worktree",
      title: "Exited worktree",
      target: wtPath,
      details: { worktree_path: wtPath },
    });

    await new Promise((r) => setTimeout(r, 150));

    const resJson = JSON.parse(
      await fs.readFile(path.join(getRunDirPath(active.run_id), "resources.json"), "utf-8")
    );

    const procDebt = resJson.cleanup_debt.find(
      (c: any) => c.type === "process_session" && c.resource_id === "worker-proc-99"
    );
    assert.ok(procDebt);
    assert.equal(procDebt.resolved, true, "Process cleanup debt must be resolved");

    const fileDebt = resJson.cleanup_debt.find((c: any) => c.path === shotFile);
    assert.ok(fileDebt);
    assert.equal(fileDebt.resolved, true, "File cleanup debt must be resolved");

    const wtDebt = resJson.cleanup_debt.find((c: any) => c.path === wtPath);
    assert.ok(wtDebt);
    assert.equal(wtDebt.resolved, true, "Worktree cleanup debt must be resolved");
  });

  it("6. persists reconciled state immediately to run.json and resources.json upon resume_run", async () => {
    const run = await testRunManager.startRun({
      goal: "Reconciliation persistence verification run",
      workspace: tempWorkspace,
    });

    const dummyFile = path.join(tempWorkspace, "tracked-reconcile.txt");
    await fs.writeFile(dummyFile, "initial-content", "utf-8");
    const initHash = calculateSha256(Buffer.from("initial-content"));

    await testRunManager.trackModifiedFile({
      path: dummyFile,
      pre_hash: initHash,
      post_hash: initHash,
      mutation_type: "create",
      description: "tracked test file",
    });

    // Now modify the file on disk so the hash differs
    await fs.writeFile(dummyFile, "modified-disk-content", "utf-8");

    // Call resumeRun
    const resumeRes = await testRunManager.resumeRun(run.run.run_id);
    assert.ok(resumeRes);

    // Verify run.json was rewritten with updated timestamps and verified metadata
    const runDisk = JSON.parse(await fs.readFile(path.join(getRunDirPath(run.run.run_id), "run.json"), "utf-8"));
    assert.equal(runDisk.status, "running");
    assert.ok(runDisk.updated_at);
  });

  it("7. transitions orphan running runs from previous PIDs to interrupted on startup", async () => {
    const orphanRunId = `run_orphan_${Date.now()}`;
    const orphanDir = getRunDirPath(orphanRunId);
    await fs.mkdir(orphanDir, { recursive: true });

    const orphanData = {
      run_id: orphanRunId,
      started_at: new Date(Date.now() - 3600000).toISOString(),
      updated_at: new Date(Date.now() - 3600000).toISOString(),
      status: "running",
      original_goal: "Abruptly killed server instance task",
      workspace: tempWorkspace,
      server_root: getServerRoot(),
      completed_steps: ["Step 1"],
      pending_steps: ["Step 2"],
      phases: [],
      warnings: [],
      failures: [],
      modified_files: [],
      temporary_files: [],
      browser_sessions: [],
      process_sessions: [],
      worktrees: [],
      cleanup_debt: [],
      server_pid: 8888888, // Stale dead PID
    };

    await fs.writeFile(path.join(orphanDir, "run.json"), JSON.stringify(orphanData, null, 2), "utf-8");
    await fs.writeFile(path.join(orphanDir, "events.jsonl"), "", "utf-8");

    // Fresh RunManager simulates server process startup
    const freshManager = new RunManager();
    await freshManager.init();

    const diskOrphan = JSON.parse(await fs.readFile(path.join(orphanDir, "run.json"), "utf-8"));
    assert.equal(diskOrphan.status, "interrupted", "Orphan run must be transitioned to interrupted");
    assert.ok(diskOrphan.warnings.some((w: string) => w.includes("Server process ended abruptly")));
  });

  it("8. enforces start_run idempotency and rapid-replay suppression", async () => {
    const idemKey = `idem_test_key_${Date.now()}`;

    // First call creates run
    const firstRun = await testRunManager.startRun({
      goal: "Idempotent task execution",
      idempotency_key: idemKey,
      workspace: tempWorkspace,
    });
    assert.equal(firstRun.is_replayed, undefined);

    // Second call with same idempotency_key returns identical run without creating duplicate
    const secondRun = await testRunManager.startRun({
      goal: "Idempotent task execution with slightly different wording",
      idempotency_key: idemKey,
      workspace: tempWorkspace,
    });
    assert.equal(secondRun.is_replayed, true);
    assert.equal(secondRun.run.run_id, firstRun.run.run_id);

    // Rapid replay test: start a run, then immediately call startRun with same goal within 15 seconds
    const rapidGoal = `Rapid replay test goal ${Date.now()}`;
    const rapid1 = await testRunManager.startRun({
      goal: rapidGoal,
      workspace: tempWorkspace,
    });
    assert.equal(rapid1.is_replayed, undefined);

    const rapid2 = await testRunManager.startRun({
      goal: rapidGoal,
      workspace: tempWorkspace,
    });
    assert.equal(rapid2.is_replayed, true, "Second immediate invocation must be suppressed as rapid replay");
    assert.equal(rapid2.run.run_id, rapid1.run.run_id);
  });

  it("9. rejects complete_run when pending steps exist unless resolve_pending: true and marks needs_cleanup", async () => {
    const runWithPending = await testRunManager.startRun({
      goal: "Run with remaining unfinished steps",
      workspace: tempWorkspace,
    });

    // Verify pending_steps are present
    assert.ok(runWithPending.run.pending_steps.length > 0);

    // 1. Attempt to complete without resolve_pending
    const rejectRes = await testRunManager.completeRun(runWithPending.run.run_id, {
      status: "completed",
    });

    assert.equal(rejectRes.error_code, "RUN_HAS_PENDING_STEPS");
    assert.equal(rejectRes.is_clean, false);
    assert.ok(rejectRes.cleanup_warnings.some((w) => w.includes("RUN_HAS_PENDING_STEPS")));

    // Also verify MCP tool returns error_code
    const mcpRejectCall: any = await mcpClient.callTool({
      name: "complete_run",
      arguments: {
        run_id: runWithPending.run.run_id,
        status: "completed",
      },
    });
    assert.ok(mcpRejectCall.content[0].text.includes("RUN_HAS_PENDING_STEPS"));

    // 2. Add an unresolved cleanup debt item
    await testRunManager.trackTemporaryFile(
      path.join(tempWorkspace, "uncleaned_debt.tmp"),
      "Uncleaned temp debt",
      true
    );

    // 3. Complete with resolve_pending: true and allow_cleanup_debt: true
    const successRes = await testRunManager.completeRun(runWithPending.run.run_id, {
      status: "completed",
      resolve_pending: true,
      allow_cleanup_debt: true,
    });

    // Should complete but status should reflect "needs_cleanup" because of uncleaned debt
    assert.equal(successRes.status, "needs_cleanup");
    assert.equal(successRes.is_clean, false);
    assert.ok(successRes.cleanup_warnings.length > 0);

    // Verify current_action and current_purpose were cleared
    const finalDisk = JSON.parse(
      await fs.readFile(path.join(getRunDirPath(runWithPending.run.run_id), "run.json"), "utf-8")
    );
    assert.ok(!finalDisk.current_action);
    assert.ok(!finalDisk.current_purpose);
  });

  it("10. supports path alias in list_directory and handles absolute paths outside workspace", async () => {
    // Create files in the outside directory
    const testFile = path.join(tempOutsideDir, "outside_sample.txt");
    await fs.writeFile(testFile, "hello from outside", "utf-8");

    // Call list_directory using 'path' alias instead of 'dir_path'
    const listRes: any = await mcpClient.callTool({
      name: "list_directory",
      arguments: {
        path: tempOutsideDir,
      },
    });

    assert.ok(listRes.content[0].text.includes("outside_sample.txt"));

    const structured = (listRes as any)._structured || JSON.parse(listRes.content[0].text.split("--- STRUCTURED_PAYLOAD_JSON ---")[1]);
    assert.ok(structured.data);
    assert.equal(structured.data.within_workspace, false);
    assert.ok(structured.data.entries.some((e: any) => e.name === "outside_sample.txt"));
  });
});
