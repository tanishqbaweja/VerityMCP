import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runManager } from "../src/runs/run_manager.js";
import {
  activityContextStorage,
  type ActivityCallContext,
} from "../src/observability/activity_stream.js";
import { processManager } from "../src/shell/process_manager.js";

function ctx(sessionId: string, toolName: string): ActivityCallContext {
  return {
    callId: `call-${sessionId}-${toolName}`,
    toolName,
    displayTitle: toolName,
    purpose: `test ${toolName} in ${sessionId}`,
    purposeSource: "caller",
    clientSessionId: sessionId,
  };
}

describe("VerityMCP cross-chat durable run isolation", () => {
  it("keeps same-workspace MCP sessions isolated and ignores another run's live resources on completion", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "verity-session-isolation-"));
    const sessionA = "mcp-test-session-A";
    const sessionB = "mcp-test-session-B";
    let processB: string | undefined;

    try {
      const startedA = await activityContextStorage.run(ctx(sessionA, "start_run"), () =>
        runManager.startRun({
          goal: "session A isolation fixture",
          workspace,
          internal_test: true,
          run_kind: "internal_test",
          project_key: "session-isolation",
          task_key: "session-a",
          idempotency_key: `session-a-${Date.now()}`,
        })
      );
      const startedB = await activityContextStorage.run(ctx(sessionB, "start_run"), () =>
        runManager.startRun({
          goal: "session B isolation fixture",
          workspace,
          internal_test: true,
          run_kind: "internal_test",
          project_key: "session-isolation",
          task_key: "session-b",
          idempotency_key: `session-b-${Date.now()}`,
        })
      );

      assert.notStrictEqual(startedA.run.run_id, startedB.run.run_id);
      assert.strictEqual(runManager.getActiveRun(sessionA)?.run_id, startedA.run.run_id);
      assert.strictEqual(runManager.getActiveRun(sessionB)?.run_id, startedB.run.run_id);

      // Start a real background resource in B. Its activity must attach only to B.
      const proc = await activityContextStorage.run(ctx(sessionB, "exec_command"), () =>
        processManager.execCommand({
          command: "Start-Sleep -Seconds 30",
          shell: "powershell",
          cwd: workspace,
          runInBackground: true,
        })
      );
      assert.strictEqual(proc.success, true, proc.text);
      processB = proc.data?.sessionId;
      assert.ok(processB);

      await new Promise((resolve) => setTimeout(resolve, 150));

      const runA = runManager.getActiveRun(sessionA);
      const runB = runManager.getActiveRun(sessionB);
      assert.ok(runA);
      assert.ok(runB);
      assert.strictEqual(runA.process_sessions.some((p) => p.id === processB), false);
      assert.strictEqual(runB.process_sessions.some((p) => p.id === processB), true);

      // A must complete even though B still owns a live process in the same server/workspace.
      const completedA = await activityContextStorage.run(ctx(sessionA, "complete_run"), () =>
        runManager.completeRun(startedA.run.run_id, {
          status: "completed",
          resolve_pending: true,
        })
      );
      assert.strictEqual(completedA.status, "completed");
      assert.strictEqual(completedA.error_code, undefined);
      assert.strictEqual(runManager.getActiveRun(sessionA), null);

      // B is still active and still owns the process.
      assert.strictEqual(runManager.getActiveRun(sessionB)?.run_id, startedB.run.run_id);
      assert.strictEqual(
        processManager.listSessions().some((p) => p.id === processB && p.status === "running"),
        true
      );

      await activityContextStorage.run(ctx(sessionB, "kill_process"), () =>
        processManager.killProcess(processB!)
      );
      processB = undefined;

      const completedB = await activityContextStorage.run(ctx(sessionB, "complete_run"), () =>
        runManager.completeRun(startedB.run.run_id, {
          status: "completed",
          resolve_pending: true,
        })
      );
      assert.strictEqual(completedB.status, "completed");
      assert.strictEqual(runManager.getActiveRun(sessionB), null);
    } finally {
      if (processB) {
        await processManager.killProcess(processB).catch(() => {});
      }
      runManager.setActiveRun(null, sessionA);
      runManager.setActiveRun(null, sessionB);
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("keeps late async completion and cross-chat cleanup bound to the resource owner", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "verity-session-owner-"));
    const sessionA = "mcp-owner-session-A";
    const sessionB = "mcp-owner-session-B";
    let shortProcess: string | undefined;
    let longProcess: string | undefined;

    try {
      const startedA = await activityContextStorage.run(ctx(sessionA, "start_run"), () =>
        runManager.startRun({
          goal: "session A async ownership fixture",
          workspace,
          internal_test: true,
          run_kind: "internal_test",
          project_key: "session-owner",
          task_key: "session-a-async",
          idempotency_key: `session-a-async-${Date.now()}`,
        })
      );
      assert.strictEqual(startedA.run.origin_mcp_session_id, sessionA);
      assert.ok(startedA.run.associated_mcp_session_ids?.includes(sessionA));

      const short = await activityContextStorage.run(ctx(sessionA, "exec_command"), () =>
        processManager.execCommand({
          command: "Start-Sleep -Milliseconds 700; Write-Output 'A_ASYNC_DONE'",
          shell: "powershell",
          cwd: workspace,
          runInBackground: true,
        })
      );
      assert.strictEqual(short.success, true, short.text);
      shortProcess = short.data?.sessionId;
      assert.ok(shortProcess);

      // Switch active work to another MCP session before A's process exits.
      const startedB = await activityContextStorage.run(ctx(sessionB, "start_run"), () =>
        runManager.startRun({
          goal: "session B concurrent fixture",
          workspace,
          internal_test: true,
          run_kind: "internal_test",
          project_key: "session-owner",
          task_key: "session-b-concurrent",
          idempotency_key: `session-b-concurrent-${Date.now()}`,
        })
      );
      assert.strictEqual(startedB.run.origin_mcp_session_id, sessionB);

      await new Promise((resolve) => setTimeout(resolve, 1400));

      const afterAsyncA = runManager.getActiveRun(sessionA);
      const afterAsyncB = runManager.getActiveRun(sessionB);
      assert.ok(afterAsyncA);
      assert.ok(afterAsyncB);
      const shortTracked = afterAsyncA.process_sessions.find((p) => p.id === shortProcess);
      assert.ok(shortTracked);
      assert.strictEqual(shortTracked.running, false);
      assert.strictEqual(shortTracked.cleanup_required, false);
      assert.strictEqual(
        afterAsyncA.cleanup_debt.find(
          (debt) => debt.type === "process_session" && debt.resource_id === shortProcess
        )?.resolved,
        true
      );
      assert.strictEqual(afterAsyncB.process_sessions.some((p) => p.id === shortProcess), false);
      shortProcess = undefined;

      // Create another A-owned resource, then explicitly kill it FROM session B.
      const long = await activityContextStorage.run(ctx(sessionA, "exec_command"), () =>
        processManager.execCommand({
          command: "Start-Sleep -Seconds 30",
          shell: "powershell",
          cwd: workspace,
          runInBackground: true,
        })
      );
      assert.strictEqual(long.success, true, long.text);
      longProcess = long.data?.sessionId;
      assert.ok(longProcess);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const killedFromB = await activityContextStorage.run(ctx(sessionB, "kill_process"), () =>
        processManager.killProcess(longProcess!)
      );
      assert.strictEqual(killedFromB.success, true, killedFromB.text);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const afterKillA = runManager.getActiveRun(sessionA);
      const afterKillB = runManager.getActiveRun(sessionB);
      assert.ok(afterKillA);
      assert.ok(afterKillB);
      const longTracked = afterKillA.process_sessions.find((p) => p.id === longProcess);
      assert.ok(longTracked);
      assert.strictEqual(longTracked.running, false);
      assert.strictEqual(longTracked.cleanup_required, false);
      assert.strictEqual(afterKillB.process_sessions.some((p) => p.id === longProcess), false);
      longProcess = undefined;

      const completedA = await activityContextStorage.run(ctx(sessionA, "complete_run"), () =>
        runManager.completeRun(startedA.run.run_id, {
          status: "completed",
          resolve_pending: true,
        })
      );
      const completedB = await activityContextStorage.run(ctx(sessionB, "complete_run"), () =>
        runManager.completeRun(startedB.run.run_id, {
          status: "completed",
          resolve_pending: true,
        })
      );
      assert.strictEqual(completedA.status, "completed");
      assert.strictEqual(completedB.status, "completed");
      assert.strictEqual(runManager.getActiveRun(sessionA), null);
      assert.strictEqual(runManager.getActiveRun(sessionB), null);
    } finally {
      if (shortProcess) await processManager.killProcess(shortProcess).catch(() => {});
      if (longProcess) await processManager.killProcess(longProcess).catch(() => {});
      runManager.setActiveRun(null, sessionA);
      runManager.setActiveRun(null, sessionB);
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  });
});
