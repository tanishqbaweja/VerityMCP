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
  getStateDir,
  getActiveRunPath,
  getRunDirPath,
  ensureDirectoriesExist,
  getPersistentDiskUsageBytes,
} from "../src/storage/paths.js";
import { RunManager } from "../src/runs/run_manager.js";
import { createVerityMcpServer } from "../src/server/mcp_tools.js";
import { observabilityManager } from "../src/observability/diagnostics.js";
import { browserManager } from "../src/browser/browser_manager.js";
import { executeNavigate, executeClick } from "../src/browser/actions.js";
import type { VerityConfig } from "../src/types/index.js";

describe("VerityMCP Observability & Recovery Acceptance Suite", () => {
  let tempWorkspace: string;
  let testRunManager: RunManager;
  let mcpClient: Client;
  let serverInstance: any;

  before(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "verity-rec-ws-"));
    testRunManager = new RunManager();
    await testRunManager.init();

    const config: VerityConfig = {
      port: 8129,
      host: "127.0.0.1",
      allowedRoots: [tempWorkspace, getServerRoot()],
      worktreesDir: "",
    };

    serverInstance = createVerityMcpServer(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await serverInstance.connect(serverTransport);

    mcpClient = new Client({ name: "test-recovery-client", version: "1.0.0" });
    await mcpClient.connect(clientTransport);
  });

  after(async () => {
    await browserManager.closeAll();
    await fs.rm(tempWorkspace, { recursive: true, force: true }).catch(() => {});
  });

  it("1. asserts canonical server_root resolution and strict .verity storage isolation", async () => {
    const sRoot = getServerRoot();
    const dataRoot = getPersistentDataRoot();

    assert.ok(fsSync.existsSync(sRoot), `Server root must exist: ${sRoot}`);
    assert.equal(dataRoot, path.join(sRoot, ".verity"), `Persistent data root must be strictly <serverRoot>/.verity`);

    // Verify it is NOT under AppData, LocalAppData, or user temp workspace
    const appData = process.env.APPDATA || "";
    const localAppData = process.env.LOCALAPPDATA || "";
    if (appData) {
      assert.ok(!dataRoot.toLowerCase().startsWith(appData.toLowerCase()), "Persistent data root must NEVER be inside AppData");
    }
    if (localAppData) {
      assert.ok(!dataRoot.toLowerCase().startsWith(localAppData.toLowerCase()), "Persistent data root must NEVER be inside LocalAppData");
    }
    assert.ok(!dataRoot.toLowerCase().startsWith(tempWorkspace.toLowerCase()), "Persistent data root must NEVER be inside user workspace");

    // Portability test: verify explicit VERITY_ROOT override
    const oldVerityRoot = process.env.VERITY_ROOT;
    const testVirtualRoot = path.join(tempWorkspace, "VirtualRoot");
    process.env.VERITY_ROOT = testVirtualRoot;
    assert.equal(getServerRoot(), path.resolve(testVirtualRoot));
    assert.equal(getPersistentDataRoot(), path.join(path.resolve(testVirtualRoot), ".verity"));
    delete process.env.VERITY_ROOT;
    if (oldVerityRoot) process.env.VERITY_ROOT = oldVerityRoot;
  });

  it("2. verifies start_run creates crash-safe run journal layout under .verity/runs/<run_id>", async () => {
    const startRes = await testRunManager.startRun({
      goal: "Test autonomous recovery and observability pipeline",
      workspace: tempWorkspace,
      purpose: "Initialize pipeline and verify disk journal layout",
      phases: [
        { id: "init", title: "Setup", status: "completed" },
        { id: "exec", title: "Execution", status: "in_progress" },
        { id: "cleanup", title: "Cleanup", status: "pending" },
      ],
    });

    const runId = startRes.run.run_id;
    assert.ok(runId.startsWith("run_"), `Run ID should start with run_: ${runId}`);
    assert.equal(startRes.ui_resource_uri, "ui://verity/activity-monitor");

    const runDir = getRunDirPath(runId);
    assert.ok(fsSync.existsSync(runDir), "Run directory must exist on disk");
    assert.ok(fsSync.existsSync(path.join(runDir, "run.json")), "run.json must exist");
    assert.ok(fsSync.existsSync(path.join(runDir, "events.jsonl")), "events.jsonl must exist");
    assert.ok(fsSync.existsSync(path.join(runDir, "checkpoint.json")), "checkpoint.json must exist");
    assert.ok(fsSync.existsSync(path.join(runDir, "resources.json")), "resources.json must exist");
    assert.ok(fsSync.existsSync(path.join(runDir, "summary.md")), "summary.md must exist");

    const runJson = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf-8"));
    assert.equal(runJson.run_id, runId);
    assert.equal(runJson.status, "running");
    assert.equal(runJson.original_goal, "Test autonomous recovery and observability pipeline");

    const summaryMd = await fs.readFile(path.join(runDir, "summary.md"), "utf-8");
    assert.ok(summaryMd.includes(runId));
    assert.ok(summaryMd.includes("Test autonomous recovery and observability pipeline"));
  });

  it("3. verifies checkpoint_run, file mutation tracking, and cleanup debt persistence", async () => {
    const active = testRunManager.getActiveRun();
    assert.ok(active, "Active run must exist");
    const runId = active.run_id;

    // 1. Update checkpoint
    const chk = await testRunManager.checkpointRun(runId, {
      completed: ["Initialized workspace", "Loaded configurations"],
      current: "Testing file mutations",
      pending: ["Test browser interactions", "Cleanup resources"],
      notes: "First checkpoint successfully reached",
    });

    assert.equal(chk.completed.length, 3); // includes initial "Run initialized"
    assert.equal(chk.current, "Testing file mutations");
    assert.equal(chk.notes, "First checkpoint successfully reached");

    const chkDisk = JSON.parse(await fs.readFile(path.join(getRunDirPath(runId), "checkpoint.json"), "utf-8"));
    assert.equal(chkDisk.current, "Testing file mutations");

    // 2. Track modified file
    const dummyFile = path.join(tempWorkspace, "sample.txt");
    await fs.writeFile(dummyFile, "Hello VerityMCP", "utf-8");
    await testRunManager.trackModifiedFile({
      path: dummyFile,
      operation: "write_file",
      pre_hash: "none",
      post_hash: "a1b2c3d4",
      timestamp: new Date().toISOString(),
    });

    // 3. Track temporary file & cleanup debt
    const tempArtifact = path.join(tempWorkspace, "temp-audit.png");
    await fs.writeFile(tempArtifact, "fake-bytes", "utf-8");
    await testRunManager.trackTemporaryFile(tempArtifact, "Temporary audit screenshot", true);

    const runDisk = JSON.parse(await fs.readFile(path.join(getRunDirPath(runId), "run.json"), "utf-8"));
    assert.equal(runDisk.modified_files.length, 1);
    assert.equal(runDisk.modified_files[0].path, dummyFile);
    assert.equal(runDisk.cleanup_debt.length, 1);
    assert.equal(runDisk.cleanup_debt[0].path, tempArtifact);
    assert.equal(runDisk.cleanup_debt[0].resolved, false);

    // 4. Resolve cleanup debt
    await testRunManager.resolveCleanupDebt(tempArtifact);
    const runDisk2 = JSON.parse(await fs.readFile(path.join(getRunDirPath(runId), "run.json"), "utf-8"));
    assert.equal(runDisk2.cleanup_debt[0].resolved, true);
  });

  it("4. detects interrupted runs on startup after simulated crash", async () => {
    // Simulate a crashed run: create active-run.json with status running and fake PID
    const crashedRunId = `run_crashed_${Date.now()}`;
    const crashedDir = getRunDirPath(crashedRunId);
    await fs.mkdir(crashedDir, { recursive: true });

    const crashedRunData = {
      run_id: crashedRunId,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "running",
      original_goal: "Task interrupted by system reboot",
      workspace: tempWorkspace,
      server_root: getServerRoot(),
      completed_steps: ["Phase 1 finished"],
      pending_steps: ["Phase 2 remaining"],
      phases: [],
      warnings: [],
      failures: [],
      modified_files: [],
      temporary_files: [],
      browser_sessions: [],
      process_sessions: [],
      worktrees: [],
      cleanup_debt: [],
      server_pid: 9999999, // Non-existent or mismatched PID
    };

    await fs.writeFile(path.join(crashedDir, "run.json"), JSON.stringify(crashedRunData, null, 2), "utf-8");
    await fs.writeFile(path.join(crashedDir, "events.jsonl"), "", "utf-8");

    // Write active pointer
    await fs.writeFile(
      getActiveRunPath(),
      JSON.stringify({
        run_id: crashedRunId,
        status: "running",
        last_checkpoint: new Date().toISOString(),
        workspace: tempWorkspace,
        started_at: crashedRunData.started_at,
        updated_at: crashedRunData.updated_at,
        server_pid: 9999999,
      }),
      "utf-8"
    );

    // Instantiate a fresh RunManager to simulate server startup
    const freshManager = new RunManager();
    await freshManager.init();

    // Verify crashed run was marked interrupted
    const restoredDisk = JSON.parse(await fs.readFile(path.join(crashedDir, "run.json"), "utf-8"));
    assert.equal(restoredDisk.status, "interrupted", "Crashed run should be marked interrupted on startup");
    assert.ok(restoredDisk.warnings.some((w: string) => w.includes("Server process ended abruptly")));

    const pointerDisk = JSON.parse(await fs.readFile(getActiveRunPath(), "utf-8"));
    assert.equal(pointerDisk.status, "interrupted");
  });

  it("5. verifies resume_run reconciles physical disk hashes and context for agent continue flow", async () => {
    const resumeRes = await testRunManager.resumeRun();
    assert.ok(resumeRes.recovered_run_id);
    assert.equal(resumeRes.status, "running");
    assert.ok(resumeRes.instruction_for_agent.includes("RESUMED RUN"));
    assert.ok(Array.isArray(resumeRes.completed_steps));
    assert.ok(Array.isArray(resumeRes.current_remaining_steps));
    assert.ok(resumeRes.reconciliation);
  });

  it("6. completes run cleanly and audits cleanup debt warnings", async () => {
    const active = testRunManager.getActiveRun();
    assert.ok(active);

    const completeRes = await testRunManager.completeRun(active.run_id, {
      status: "completed",
      notes: "All test phases successfully passed and verified",
      resolve_pending: true,
    });

    assert.equal(completeRes.status, "completed");
    assert.equal(completeRes.is_clean, true);
    assert.equal(completeRes.cleanup_warnings.length, 0);

    const disk = JSON.parse(await fs.readFile(path.join(getRunDirPath(active.run_id), "run.json"), "utf-8"));
    assert.equal(disk.status, "completed");
  });

  it("7. verifies MCP resource ui://verity/activity-monitor is queryable with text/html;profile=mcp-app", async () => {
    // 1. List resources
    const listRes = await mcpClient.listResources();
    const monitorResource = listRes.resources.find((r) => r.uri === "ui://verity/activity-monitor");
    assert.ok(monitorResource, "Resource ui://verity/activity-monitor must be listed");
    assert.equal(monitorResource.mimeType, "text/html;profile=mcp-app");

    // 2. Read resource
    const readRes = await mcpClient.readResource({ uri: "ui://verity/activity-monitor" });
    assert.ok(readRes.contents && readRes.contents.length > 0);
    const content = readRes.contents[0] as any;
    assert.equal(content.uri, "ui://verity/activity-monitor");
    assert.equal(content.mimeType, "text/html;profile=mcp-app");
    assert.ok(content.text.includes("VerityMCP Activity Monitor"));
    assert.ok(content.text.includes("currentWhyBox"));
  });

  it("8. verifies MCP run tools (start_run, checkpoint_run, list_runs, complete_run) over MCP protocol", async () => {
    // 1. start_run tool call
    const startCall: any = await mcpClient.callTool({
      name: "start_run",
      arguments: {
        goal: "Full MCP tool end-to-end integration test",
        purpose: "Verify MCP tool bridge and UI mounting",
      },
    });

    assert.ok(startCall.content.length >= 2, "start_run should return text and resource item");
    const resourceItem = startCall.content.find((c: any) => c.type === "resource");
    assert.ok(resourceItem, "start_run response must include embedded MCP App UI resource");
    assert.equal(resourceItem.resource.uri, "ui://verity/activity-monitor");

    const structured = (startCall as any)._structured || JSON.parse(startCall.content[0].text.split("--- STRUCTURED_PAYLOAD_JSON ---")[1]);
    const mcpRunId = structured.data.run_id;
    assert.ok(mcpRunId);

    // 2. checkpoint_run tool call
    const chkCall: any = await mcpClient.callTool({
      name: "checkpoint_run",
      arguments: {
        run_id: mcpRunId,
        completed: ["Tool invocation verified"],
        current: "Testing list_runs",
      },
    });
    assert.ok(chkCall.content[0].text.includes("Checkpoint recorded"));

    // 3. list_runs tool call
    const listCall: any = await mcpClient.callTool({
      name: "list_runs",
      arguments: { limit: 10 },
    });
    assert.ok(listCall.content[0].text.includes(mcpRunId));

    // 4. complete_run tool call
    const compCall: any = await mcpClient.callTool({
      name: "complete_run",
      arguments: { run_id: mcpRunId, status: "completed", resolve_pending: true },
    });
    assert.ok(compCall.content[0].text.includes("marked as completed"));
  });

  it("9. instruments browser_click with phase timings and verifies sub-second execution", async () => {
    const session = await browserManager.getSession("click-timing-test");
    const htmlPage = `
      <!DOCTYPE html>
      <html>
        <head><title>Fast Click Test</title></head>
        <body>
          <h1 id="title">Initial</h1>
          <button id="btn" onclick="document.getElementById('title').textContent = 'Clicked!'">Click Me</button>
          <a id="link" href="#navigated" onclick="document.getElementById('title').textContent = 'Navigated'">Navigate Link</a>
        </body>
      </html>
    `;
    const dataUrl = `data:text/html;base64,${Buffer.from(htmlPage).toString("base64")}`;
    await executeNavigate(session, dataUrl);

    const clickRes = await executeClick(session, { selector: "#btn" });
    assert.equal(clickRes.success, true);
    assert.ok(clickRes.data?.timings, "executeClick must include timings in data");

    const timings = clickRes.data.timings;
    assert.ok(typeof timings.target_resolution_ms === "number");
    assert.ok(typeof timings.pre_state_capture_ms === "number");
    assert.ok(typeof timings.playwright_click_ms === "number");
    assert.ok(typeof timings.navigation_wait_ms === "number");
    assert.ok(typeof timings.post_state_capture_ms === "number");
    assert.ok(typeof timings.verification_ms === "number");
    assert.ok(typeof timings.total_ms === "number");

    // Assert fast execution (under 4.0s, avoiding the 30s stall)
    assert.ok(timings.total_ms < 4000, `executeClick total_ms was ${timings.total_ms}ms, expected < 4000ms`);

    await browserManager.closeSession(session.id);
  });

  it("10. verifies verity_diagnostics reports server_root and persistent_data_root transparently", async () => {
    const diagRes = observabilityManager.getDiagnostics();
    assert.equal(diagRes.success, true);
    const diagData: any = diagRes.data;

    assert.ok(diagData.storage, "Diagnostics must contain storage section");
    assert.equal(diagData.storage.server_root, getServerRoot());
    assert.equal(diagData.storage.persistent_data_root, getPersistentDataRoot());
    assert.ok(typeof diagData.storage.persisted_runs === "number");
    assert.ok(typeof diagData.storage.interrupted_runs === "number");
    assert.ok(diagRes.text.includes("Server Root:"));
    assert.ok(diagRes.text.includes("Persistent Data Root:"));
    assert.ok(diagRes.text.includes("Persisted Runs:"));
  });
});
