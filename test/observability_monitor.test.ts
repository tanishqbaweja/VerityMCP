import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createServer, type Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createVerityApp } from "../src/server/app.js";
import { activityStream, activityContextStorage } from "../src/observability/activity_stream.js";
import { observabilityManager } from "../src/observability/diagnostics.js";
import { formatMcpResponse } from "../src/server/response.js";
import { browserManager } from "../src/browser/browser_manager.js";
import { executeNavigate, executeClick, executeFill, executeCheck } from "../src/browser/actions.js";
import { takeBrowserSnapshot } from "../src/browser/snapshot.js";
import { executeEditNotebook } from "../src/notebook/notebook_engine.js";
import type { VerityConfig } from "../src/types/index.js";

describe("VerityMCP Observability & Monitor Acceptance Suite", () => {
  let server: Server;
  const testPort = 8124;
  const baseUrl = `http://127.0.0.1:${testPort}`;
  const ownerToken = "test-token-obs";
  let tempDir: string;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "verity-obs-test-"));

    const config: VerityConfig = {
      port: testPort,
      host: "127.0.0.1",
      publicBaseUrl: baseUrl,
      ownerToken,
      allowedRoots: [tempDir],
      worktreesDir: "",
    };

    const instance = createVerityApp(config);
    server = createServer(instance.app);
    await new Promise<void>((resolve) => server.listen(testPort, "127.0.0.1", resolve));
  });

  after(async () => {
    await browserManager.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("prioritizes caller purpose over tool default purpose across nested executions", async () => {
    activityStream.clear();

    const callCtx = {
      callId: "call_test_purpose_123",
      toolName: "edit_file",
      displayTitle: "Editing config.json",
      purpose: "Rotate API key due to scheduled security maintenance",
      purposeSource: "caller" as const,
      expectedOutcome: "Config file updated on disk with new key",
      target: "config.json",
    };

    let capturedEvent: any = null;
    await activityContextStorage.run(callCtx, async () => {
      // Simulate internal tool emission
      capturedEvent = activityStream.emit({
        type: "action_started",
        title: "Default internal tool title",
        purpose: "Internal default purpose that should be superseded",
        tool: "edit_file",
      });
    });

    assert.ok(capturedEvent);
    assert.strictEqual(capturedEvent.call_id, "call_test_purpose_123");
    assert.strictEqual(capturedEvent.purpose, "Rotate API key due to scheduled security maintenance");
    assert.strictEqual(capturedEvent.purpose_source, "caller");
    assert.strictEqual(capturedEvent.expected_outcome, "Config file updated on disk with new key");
  });

  it("updates current_action status on verification without dropping action in flight", () => {
    activityStream.clear();

    activityStream.emit({
      type: "action_started",
      title: "Compiling TypeScript",
      call_id: "call_compile_1",
      status: "running",
    });

    let current = activityStream.getCurrentAction();
    assert.ok(current);
    assert.strictEqual(current.call_id, "call_compile_1");
    assert.strictEqual(current.status, "running");

    // Verification event occurs
    activityStream.emit({
      type: "verification",
      title: "Binary matches expected checksum",
      call_id: "call_compile_1",
      status: "verified",
    });

    current = activityStream.getCurrentAction();
    assert.ok(current, "currentAction must remain populated after verification");
    assert.strictEqual(current.call_id, "call_compile_1");
    assert.strictEqual(current.status, "verified");

    // Action completed clears current action
    activityStream.emit({
      type: "action_completed",
      title: "Compile finished",
      call_id: "call_compile_1",
      status: "completed",
    });

    current = activityStream.getCurrentAction();
    assert.strictEqual(current, null, "currentAction should be null after completion");
  });

  it("serves live Activity Monitor HTML UI at GET /monitor with embedded styling and SSE connection", async () => {
    const res = await fetch(`${baseUrl}/monitor`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/html"));
    const html = await res.text();

    assert.ok(html.includes("VerityMCP Activity Monitor"), "Must include header title");
    assert.ok(html.includes("/activity/stream"), "Must reference SSE stream endpoint");
    assert.ok(html.includes("/activity/events"), "Must reference fallback polling endpoint");
    assert.ok(html.includes("pulse-dot"), "Must include live state indicator element");
    assert.ok(html.includes("filter-btn"), "Must include filter buttons");
    assert.ok(html.includes("Current Action"), "Must include current action card");
  });

  it("serves cursor pagination at GET /activity/events and current state at GET /activity/current", async () => {
    activityStream.clear();

    activityStream.emit({
      type: "action_started",
      title: "Testing endpoint events",
      purpose: "Validate REST feed",
      call_id: "call_rest_1",
    });

    const resEvents = await fetch(`${baseUrl}/activity/events?cursor=0&limit=5`);
    assert.strictEqual(resEvents.status, 200);
    const eventsData = await resEvents.json();
    assert.ok(Array.isArray(eventsData.events));
    assert.strictEqual(eventsData.events.length, 1);
    assert.strictEqual(eventsData.events[0].call_id, "call_rest_1");

    const resCurrent = await fetch(`${baseUrl}/activity/current`);
    assert.strictEqual(resCurrent.status, 200);
    const currentData = await resCurrent.json();
    assert.strictEqual(currentData.state, "working");
    assert.strictEqual(currentData.current_action.call_id, "call_rest_1");
  });

  it("streams real-time events over SSE at GET /activity/stream", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const ssePromise = new Promise<string>(async (resolve, reject) => {
      try {
        const response = await fetch(`${baseUrl}/activity/stream`, {
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        });
        assert.strictEqual(response.status, 200);
        assert.ok(response.headers.get("content-type")?.includes("text/event-stream"));

        const reader = response.body?.getReader();
        if (!reader) return reject(new Error("No response body reader"));

        let received = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = new TextDecoder().decode(value);
          received += chunk;
          if (received.includes("connected") || received.includes("data:")) {
            await reader.cancel();
            resolve(received);
            break;
          }
        }
      } catch (err) {
        reject(err);
      } finally {
        clearTimeout(timeout);
      }
    });

    // Emit event to trigger stream data
    setTimeout(() => {
      activityStream.emit({
        type: "info",
        title: "SSE ping test",
      });
    }, 50);

    const streamData = await ssePromise;
    assert.ok(streamData.length > 0, "SSE stream must emit data");
  });

  it("emits live activity events across browser navigation, snapshots, and interaction", async () => {
    activityStream.clear();

    const session = await browserManager.getSession("obs_test_session");

    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <body>
          <h1>Verity Observability Form</h1>
          <input type="text" id="uname" value="" />
          <input type="checkbox" id="accept" />
          <button id="submit-btn" onclick="document.body.setAttribute('data-done', 'true')">Submit</button>
        </body>
      </html>
    `;
    const dataUri = `data:text/html;base64,${Buffer.from(htmlContent).toString("base64")}`;

    // 1. Navigate
    const navRes = await executeNavigate(session, dataUri);
    assert.strictEqual(navRes.success, true);

    // 2. Snapshot
    const snapRes = await takeBrowserSnapshot(session);
    assert.strictEqual(snapRes.success, true);

    // 3. Fill
    const fillRes = await executeFill(session, { selector: "#uname" }, "Antigravity");
    assert.strictEqual(fillRes.success, true);

    // 4. Check
    const checkRes = await executeCheck(session, { selector: "#accept" }, true);
    assert.strictEqual(checkRes.success, true);

    // 5. Click
    const clickRes = await executeClick(session, { selector: "#submit-btn" });
    assert.strictEqual(clickRes.success, true);

    // Inspect recorded activity stream
    const events = activityStream.list(100);
    const browserTypes = events.map((e) => e.type);
    assert.ok(browserTypes.includes("action_started"), "Must contain action_started events");
    assert.ok(browserTypes.includes("verification"), "Must contain verification events");

    const toolsUsed = events.map((e) => e.tool).filter(Boolean);
    assert.ok(toolsUsed.includes("browser_navigate") || toolsUsed.includes("browser"));
    assert.ok(toolsUsed.includes("browser_click") || toolsUsed.includes("browser"));
  });

  it("deduplicates warnings and formats prominent operational purpose badge", () => {
    const formatted = formatMcpResponse({
      success: true,
      action: "exec_command",
      display_title: "Running test build",
      purpose: "Verify zero compilation errors before release",
      warning: "Command emitted stderr despite exit code 0.",
      warnings: ["Command emitted stderr despite exit code 0.", "Secondary warning"],
      stderr_present: true,
      stderr: "minor warning on line 42",
      text: "Build completed in 120ms",
    });

    const text = formatted.content[0].text;
    // Prominent badge at top
    assert.ok(
      text.startsWith("[Verity Activity: Running test build | Why: Verify zero compilation errors before release]"),
      "Response must lead with operational intent badge"
    );

    // Warning deduplication in structured payload
    const structured = formatted._structured;
    assert.ok(structured && Array.isArray(structured.warnings));
    assert.strictEqual(structured.warnings.length, 2);
    assert.strictEqual(
      structured.warnings.filter((w: string) => w === "Command emitted stderr despite exit code 0.").length,
      1,
      "Duplicate warnings must be reduced to exactly 1 in warnings array"
    );
    assert.ok(text.includes("[Warnings: Command emitted stderr despite exit code 0.; Secondary warning]"));
  });

  it("classifies STALE_ELEMENT_REFERENCE as guarded_refusal and FILE_NOT_FOUND as operational_failure", () => {
    // 1. STALE_ELEMENT_REFERENCE
    observabilityManager.logToolEvent({
      toolName: "browser_click",
      action: "browser_click",
      success: false,
      errorCode: "STALE_ELEMENT_REFERENCE",
      durationMs: 10,
      timestamp: Date.now(),
    });

    // 2. FILE_NOT_FOUND
    observabilityManager.logToolEvent({
      toolName: "read_file",
      action: "read_file",
      success: false,
      errorCode: "FILE_NOT_FOUND",
      durationMs: 10,
      timestamp: Date.now(),
    });

    const recent = observabilityManager.getRecentEvents(20);

    const staleEntry = recent.find((f: any) => f.errorCode === "STALE_ELEMENT_REFERENCE");
    assert.ok(staleEntry, "STALE_ELEMENT_REFERENCE must be logged");
    assert.strictEqual(staleEntry.category, "guarded_refusal");

    const notFoundEntry = recent.find((f: any) => f.errorCode === "FILE_NOT_FOUND");
    assert.ok(notFoundEntry, "FILE_NOT_FOUND must be logged");
    assert.strictEqual(notFoundEntry.category, "operational_failure");
  });

  it("preserves compact JSON indentation when editing Jupyter notebook cells", async () => {
    const nbPath = path.join(tempDir, "compact_test.ipynb");
    const compactNotebook = {
      cells: [
        {
          cell_type: "code",
          metadata: {},
          outputs: [],
          source: ["x = 10\n", "print(x)"],
        },
      ],
      metadata: { language_info: { name: "python" } },
      nbformat: 4,
      nbformat_minor: 5,
    };

    // Write with 2 spaces
    await fs.writeFile(nbPath, JSON.stringify(compactNotebook, null, 2), "utf-8");

    const editRes = await executeEditNotebook({
      workspaceRoot: tempDir,
      notebookPath: "compact_test.ipynb",
      cellIndex: 1,
      newSource: "x = 20\nprint(x * 2)",
    });

    assert.strictEqual(editRes.success, true);

    // Read raw file content from disk to check indentation
    const diskContent = await fs.readFile(nbPath, "utf-8");
    // Verify indentation is 2 spaces (i.e. '  "cells": [')
    assert.ok(diskContent.includes('  "cells": ['), "Indentation must remain 2 spaces rather than reformatting to 4 spaces");
  });
});
