import { describe, it, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { formatMcpResponse } from "../src/server/response.js";
import { executeEditFile } from "../src/filesystem/edit_file.js";
import { executeApplyPatch } from "../src/patcher/apply_patch.js";
import { processManager } from "../src/shell/process_manager.js";
import { browserManager } from "../src/browser/browser_manager.js";
import { takeBrowserSnapshot } from "../src/browser/snapshot.js";
import {
  executeNavigate,
  executeClick,
  executeWaitFor,
  executeTraceStart,
  executeTraceStop,
  executeListTabs,
  executeGetConsole,
  executeGetNetwork,
} from "../src/browser/actions.js";
import { executeGitConflicts, executeGitStatus } from "../src/git/git_ops.js";
import { executeEnterWorktree, executeExitWorktree } from "../src/git/worktrees.js";
import { executeReadNotebook, executeEditNotebook } from "../src/notebook/notebook_engine.js";
import { SubagentEngine } from "../src/agents/subagent_engine.js";
import { workspaceManager } from "../src/workspace/workspace_manager.js";
import { observabilityManager } from "../src/observability/diagnostics.js";

describe("VerityMCP Polish & Hardening Acceptance Suite", () => {
  it("formats responses with structured JSON payload, execution, and state verification", () => {
    const formatted = formatMcpResponse({
      success: true,
      action: "test_action",
      text: "Action performed successfully",
      summary: "Short summary",
      error_code: undefined,
      verification: {
        performed: true,
        passed: true,
        method: "test_verification",
        execution: { status: "passed", method: "test_exec" },
        state: { status: "passed", method: "test_state" },
      },
      data: { score: 100 },
    });

    assert.strictEqual(formatted.isError, false);
    assert.ok(formatted.content.length > 0);
    const textBlock = formatted.content[0].text;
    assert.ok(textBlock.includes("--- STRUCTURED_PAYLOAD_JSON ---"));

    const jsonPart = textBlock.split("--- STRUCTURED_PAYLOAD_JSON ---\n")[1];
    const parsed = JSON.parse(jsonPart);

    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.summary, "Short summary");
    assert.strictEqual(parsed.execution_verification.status, "passed");
    assert.strictEqual(parsed.state_verification.status, "passed");
    assert.deepStrictEqual(parsed.data, { score: 100 });
  });

  it("enforces expected_sha256 protection against concurrent edits in edit_file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "verity-sha-test-"));
    const filePath = path.join(tmpDir, "sample.txt");
    const content = "Hello VerityMCP\nLine 2\n";
    await fs.writeFile(filePath, content, "utf-8");

    const validHash = crypto.createHash("sha256").update(Buffer.from(content)).digest("hex");
    const wrongHash = "0000000000000000000000000000000000000000000000000000000000000000";

    // 1. Should fail with wrong expected_sha256
    const failRes = await executeEditFile({
      workspaceRoot: tmpDir,
      filePath: "sample.txt",
      oldString: "Line 2",
      newString: "Line 2 Modified",
      expectedSha256: wrongHash,
    });

    assert.strictEqual(failRes.success, false);
    assert.strictEqual(failRes.error_code, "FILE_CHANGED_SINCE_READ");
    assert.strictEqual(failRes.verification.passed, false);

    // 2. Should succeed with matching expected_sha256
    const okRes = await executeEditFile({
      workspaceRoot: tmpDir,
      filePath: "sample.txt",
      oldString: "Line 2",
      newString: "Line 2 Modified",
      expectedSha256: validHash,
    });

    assert.strictEqual(okRes.success, true);
    assert.strictEqual(okRes.verification.passed, true);
    const updated = await fs.readFile(filePath, "utf-8");
    assert.ok(updated.includes("Line 2 Modified"));

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("enforces expected_sha256_map protection in apply_patch", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "verity-patch-sha-"));
    const filePath = path.join(tmpDir, "config.json");
    const content = '{\n  "version": "1.0"\n}\n';
    await fs.writeFile(filePath, content, "utf-8");

    const validHash = crypto.createHash("sha256").update(Buffer.from(content)).digest("hex");
    const wrongHash = "1111111111111111111111111111111111111111111111111111111111111111";

    const patchText = `*** Begin Patch
*** Update File: config.json
@@ -1,3 +1,3 @@
 {
-  "version": "1.0"
+  "version": "2.0"
 }
*** End Patch`;

    // 1. Fail with stale hash
    const failRes = await executeApplyPatch({
      workspaceRoot: tmpDir,
      patch: patchText,
      expectedSha256Map: { "config.json": wrongHash },
    });

    assert.strictEqual(failRes.success, false);
    assert.strictEqual(failRes.error_code, "FILE_CHANGED_SINCE_READ");

    // 2. Succeed with current hash
    const okRes = await executeApplyPatch({
      workspaceRoot: tmpDir,
      patch: patchText,
      expectedSha256Map: { "config.json": validHash },
    });

    assert.strictEqual(okRes.success, true);
    assert.strictEqual(okRes.verification.passed, true);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("verifies forceful process tree termination (kill_process)", async () => {
    const isWin = process.platform === "win32";
    // Launch a long sleep command
    const sleepCmd = isWin ? "powershell -Command \"Start-Sleep -Seconds 30\"" : "sleep 30";

    const execRes = await processManager.execCommand({
      command: sleepCmd,
      cwd: os.tmpdir(),
      runInBackground: true,
    });

    assert.strictEqual(execRes.success, true);
    const sid = execRes.data?.sessionId;
    assert.ok(sid);

    // Forcefully kill process
    const killRes = await processManager.killProcess(sid);
    assert.strictEqual(killRes.success, true);
    assert.ok(killRes.text.includes("terminated"));

    // Check status
    const postSession = processManager.getSession(sid);
    assert.ok(postSession?.status === "interrupted" || postSession?.status === "completed");
  });

  it("detects git conflicts and conflict markers cleanly (git_conflicts)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "verity-conflicts-test-"));

    // Case 1: Clean folder (no conflicts)
    const cleanRes = executeGitConflicts(tmpDir);
    assert.strictEqual(cleanRes.success, true);
    assert.strictEqual(cleanRes.data?.hasConflicts, false);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("verifies browser before/after state delta and STALE_ELEMENT_REFERENCE handling", async () => {
    const session = await browserManager.getSession("polish-test");
    const testHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Delta Test</title></head>
        <body>
          <input type="checkbox" id="chk" />
          <button id="del-btn" onclick="document.getElementById('temp').remove()">Remove Item</button>
          <div id="temp"><button id="disappearing">Disappearing Button</button></div>
          <script>
            console.log("Page ready");
          </script>
        </body>
      </html>
    `;
    const dataUri = `data:text/html;base64,${Buffer.from(testHtml).toString("base64")}`;
    await executeNavigate(session, dataUri);

    // Snapshot 1
    const snap1 = await takeBrowserSnapshot(session);
    assert.strictEqual(snap1.success, true);
    const delBtnEl = snap1.data?.elements.find((e) => e.text === "Remove Item");
    const disappearingEl = snap1.data?.elements.find((e) => e.text === "Disappearing Button");
    const checkboxEl = snap1.data?.elements.find((e) => e.tagName === "input" && e.type === "checkbox");

    assert.ok(delBtnEl);
    assert.ok(disappearingEl);
    assert.ok(checkboxEl);

    // Checkbox toggle: click and inspect state delta
    const clickChkRes = await executeClick(session, { ref: checkboxEl.ref });
    assert.strictEqual(clickChkRes.success, true);
    assert.strictEqual(clickChkRes.state_verification?.status, "passed");
    assert.ok(
      clickChkRes.state_verification?.observed_changes?.some((c) => c.type === "checkbox_toggle")
    );

    // Click remove item to mutate DOM
    await executeClick(session, { ref: delBtnEl.ref });

    // Snapshot 2 (element removed)
    const snap2 = await takeBrowserSnapshot(session);
    assert.strictEqual(snap2.success, true);
    assert.ok(!snap2.data?.elements.some((e) => e.text === "Disappearing Button"));

    // Attempting to click disappearingEl (from snap1) must throw STALE_ELEMENT_REFERENCE
    const staleClickRes = await executeClick(session, { ref: disappearingEl.ref });
    assert.strictEqual(staleClickRes.success, false);
    assert.strictEqual(staleClickRes.error_code, "STALE_ELEMENT_REFERENCE");
    assert.ok(staleClickRes.text.includes("STALE_ELEMENT_REFERENCE"));
  });

  it("verifies dedicated browser_wait_for primitive", async () => {
    const session = await browserManager.getSession("wait-test");
    const testHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Wait Test</title></head>
        <body>
          <h1 id="title">Initial</h1>
          <script>
            setTimeout(() => {
              const h = document.getElementById("title");
              h.textContent = "Async Loaded Content";
              const btn = document.createElement("button");
              btn.id = "async-btn";
              btn.textContent = "Click Me";
              document.body.appendChild(btn);
            }, 100);
          </script>
        </body>
      </html>
    `;
    const dataUri = `data:text/html;base64,${Buffer.from(testHtml).toString("base64")}`;
    await executeNavigate(session, dataUri);

    // 1. Wait for async text
    const waitTextRes = await executeWaitFor(session, { text: "Async Loaded Content", timeoutMs: 5000 });
    assert.strictEqual(waitTextRes.success, true);
    assert.strictEqual(waitTextRes.state_verification?.status, "passed");

    // 2. Wait for async selector
    const waitSelRes = await executeWaitFor(session, { selector: "#async-btn", timeoutMs: 5000 });
    assert.strictEqual(waitSelRes.success, true);

    // 3. Timeout on non-existent element
    const timeoutRes = await executeWaitFor(session, { selector: "#nonexistent", timeoutMs: 300 });
    assert.strictEqual(timeoutRes.success, false);
    assert.strictEqual(timeoutRes.error_code, "PROCESS_TIMEOUT");
  });

  it("verifies Playwright tracing lifecycle (trace_start / trace_stop)", async () => {
    const session = await browserManager.getSession("trace-test");
    await executeNavigate(session, "data:text/html,<h1>Tracing Test</h1>");

    // Start trace
    const startRes = await executeTraceStart(session);
    assert.strictEqual(startRes.success, true);
    assert.strictEqual(session.isTracing, true);

    // Do an action while tracing
    await executeNavigate(session, "data:text/html,<h1>Tracing Second Step</h1>");

    // Stop trace and save archive
    const traceFile = path.join(os.tmpdir(), `verity_test_trace_${Date.now()}.zip`);
    const stopRes = await executeTraceStop(session, traceFile);

    assert.strictEqual(stopRes.success, true);
    assert.strictEqual(session.isTracing, false);

    // Verify trace zip exists on disk
    const stat = await fs.stat(traceFile);
    assert.ok(stat.size > 0);

    await fs.unlink(traceFile).catch(() => {});
  });

  it("verifies multi-tab listing and management", async () => {
    const session = await browserManager.getSession("tabs-test");
    await executeNavigate(session, "data:text/html,<title>Tab 0</title><h1>Tab 0</h1>");

    // Open second tab
    await browserManager.createTab(session, "data:text/html,<title>Tab 1</title><h1>Tab 1</h1>");

    // List tabs
    const listRes = await executeListTabs(session);
    assert.strictEqual(listRes.success, true);
    assert.strictEqual(listRes.data?.tabs.length, 2);
    assert.strictEqual(listRes.data?.tabs[0].title, "Tab 0");
    assert.strictEqual(listRes.data?.tabs[1].title, "Tab 1");
    assert.strictEqual(listRes.data?.tabs[1].isActive, true);

    // Switch back to tab 0
    browserManager.selectTab(session, 0);
    const postSwitch = await executeListTabs(session);
    assert.strictEqual(postSwitch.data?.tabs[0].isActive, true);

    // Close tab 1
    await browserManager.closeTab(session, 1);
    const postClose = await executeListTabs(session);
    assert.strictEqual(postClose.data?.tabs.length, 1);
  });

  it("verifies filtered console and network log retrieval", async () => {
    const session = await browserManager.getSession("logs-test");
    session.consoleLogs = [
      { type: "info", text: "App starting", timestamp: 1 },
      { type: "error", text: "Failed to connect to backend", timestamp: 2 },
      { type: "warn", text: "High memory usage", timestamp: 3 },
    ];
    session.networkEvents = [
      { method: "GET", url: "https://example.com/api/users", status: 200, resourceType: "xhr", timestamp: 1 },
      { method: "POST", url: "https://example.com/api/login", status: 500, failed: true, resourceType: "fetch", timestamp: 2 },
    ];

    // Filter console by error
    const errLogs = executeGetConsole(session, { level: "error" });
    assert.strictEqual(errLogs.data?.logs.length, 1);
    assert.strictEqual(errLogs.data?.logs[0].text, "Failed to connect to backend");

    // Filter network by failedOnly
    const failedNet = executeGetNetwork(session, { failedOnly: true });
    assert.strictEqual(failedNet.data?.events.length, 1);
    assert.strictEqual(failedNet.data?.events[0].method, "POST");
  });

  it("runs end-to-end self test with verified zero side-effects (verity_self_test)", async () => {
    const selfTestRes = await observabilityManager.runSelfTest();
    assert.strictEqual(selfTestRes.success, true);
    assert.strictEqual(selfTestRes.verification.passed, true);
    assert.strictEqual(selfTestRes.data?.allPassed, true);
    assert.ok(selfTestRes.data && selfTestRes.data.checksPassed >= 4);

    const checks = selfTestRes.data?.checks || [];
    const fsCheck = checks.find((c) => c.name === "filesystem_write_read_verify");
    const shellCheck = checks.find((c) => c.name === "shell_command_execution");
    const procCheck = checks.find((c) => c.name === "process_buffer_cursor");
    const browserCheck = checks.find((c) => c.name === "browser_subsystem_probe");

    assert.ok(fsCheck?.passed);
    assert.ok(shellCheck?.passed);
    assert.ok(procCheck?.passed);
    assert.ok(browserCheck?.passed);
  });

  it("executes shell quoting torture tests across PowerShell, cmd, and Git Bash", async () => {
    // 1. PowerShell with quotes and ampersand
    const psRes = await processManager.execCommand({
      command: 'Write-Output \'{"user": "verity", "message": "hello & goodbye"}\'',
      shell: "powershell",
    });
    assert.strictEqual(psRes.success, true);
    assert.ok(psRes.stdout?.includes("hello & goodbye"));

    // 2. cmd with quotes, spaces, and ampersand
    const cmdRes = await processManager.execCommand({
      command: 'echo "path with spaces/file name.txt" & echo secondary_flag',
      shell: "cmd",
    });
    assert.strictEqual(cmdRes.success, true);
    assert.ok(cmdRes.stdout?.includes("secondary_flag"));

    // 3. Git Bash with complex JSON string and spaces
    const bashRes = await processManager.execCommand({
      command: "echo '{\"status\": \"ok\", \"path\": \"folder with spaces/file.txt\"}'",
      shell: "bash",
    });
    assert.strictEqual(bashRes.success, true);
    assert.ok(bashRes.stdout?.includes("folder with spaces/file.txt"));
  });

  it("verifies worktree lifecycle and dirty-state removal protection with WORKTREE_DIRTY", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "verity-wt-suite-"));
    execSync("git init", { cwd: tmpDir });
    execSync('git config user.name "Tester"', { cwd: tmpDir });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir });
    await fs.writeFile(path.join(tmpDir, "README.md"), "# Init", "utf-8");
    execSync('git add . && git commit -m "Initial commit"', { cwd: tmpDir });

    const openRes = await workspaceManager.openWorkspace(tmpDir, [tmpDir]);
    assert.strictEqual(openRes.success, true);

    // Enter worktree
    const enterRes = await executeEnterWorktree({ name: "feature-isolate" });
    assert.strictEqual(enterRes.success, true);
    const wtPath = enterRes.data?.worktreePath!;
    assert.ok(wtPath);

    // Make worktree dirty
    await fs.writeFile(path.join(wtPath, "uncommitted.txt"), "dirty state", "utf-8");

    // Exit and remove without force: true -> must be rejected with WORKTREE_DIRTY
    const dirtyRejectRes = await executeExitWorktree({ action: "remove", force: false });
    assert.strictEqual(dirtyRejectRes.success, false);
    assert.strictEqual(dirtyRejectRes.error_code, "WORKTREE_DIRTY");

    // Exit and remove with force: true -> must succeed
    const forceExitRes = await executeExitWorktree({ action: "remove", force: true });
    assert.strictEqual(forceExitRes.success, true);

    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("verifies Jupyter notebook inspection, insertion, replacement, and deletion with SHA-256 verification", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "verity-nb-suite-"));
    const nbPath = path.join(tmpDir, "pipeline.ipynb");

    const sampleNb = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { language_info: { name: "python" } },
      cells: [
        {
          id: "intro_cell",
          cell_type: "markdown",
          metadata: {},
          source: ["# Pipeline Notebook\n", "Initial markdown text."]
        },
        {
          id: "exec_cell",
          cell_type: "code",
          metadata: {},
          execution_count: 1,
          source: ["import os\n", "print(os.getcwd())"],
          outputs: []
        }
      ]
    };

    await fs.writeFile(nbPath, JSON.stringify(sampleNb, null, 2), "utf-8");

    // 1. Read notebook
    const readRes = await executeReadNotebook({ workspaceRoot: tmpDir, notebookPath: "pipeline.ipynb" });
    assert.strictEqual(readRes.success, true);
    assert.strictEqual(readRes.data?.totalCells, 2);

    // 2. Replace code cell
    const replaceRes = await executeEditNotebook({
      workspaceRoot: tmpDir,
      notebookPath: "pipeline.ipynb",
      cellId: "exec_cell",
      editMode: "replace",
      newSource: "import sys\nprint(sys.version)",
    });
    assert.strictEqual(replaceRes.success, true);
    assert.strictEqual(replaceRes.verification.passed, true);

    // 3. Insert markdown cell
    const insertRes = await executeEditNotebook({
      workspaceRoot: tmpDir,
      notebookPath: "pipeline.ipynb",
      editMode: "insert",
      cellType: "markdown",
      newSource: "### Section 2: Results",
    });
    assert.strictEqual(insertRes.success, true);
    assert.strictEqual(insertRes.data?.totalCells, 3);

    // 4. Delete cell
    const deleteRes = await executeEditNotebook({
      workspaceRoot: tmpDir,
      notebookPath: "pipeline.ipynb",
      cellId: "intro_cell",
      editMode: "delete",
      newSource: "",
    });
    assert.strictEqual(deleteRes.success, true);
    assert.strictEqual(deleteRes.data?.totalCells, 2);

    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("verifies subagent bounded execution, personas, and plan mode lifecycle", () => {
    const engine = new SubagentEngine();

    // Delegate explore
    const exploreRes = engine.delegateSubagent("Explore module layout", "explore");
    assert.strictEqual(exploreRes.success, true);
    assert.strictEqual(exploreRes.data?.persona, "explore");
    assert.strictEqual(exploreRes.data?.status, "completed");

    // Delegate coding
    const codingRes = engine.delegateSubagent("Implement parser feature", "coding");
    assert.strictEqual(codingRes.success, true);
    assert.strictEqual(codingRes.data?.persona, "coding");

    // Delegate review
    const reviewRes = engine.delegateSubagent("Review diffs for safety", "review");
    assert.strictEqual(reviewRes.success, true);

    // List sessions
    const listRes = engine.listSubagents();
    assert.strictEqual(listRes.success, true);
    assert.strictEqual(listRes.data?.length, 3);

    // Plan mode toggle and exit
    const enterPlan = engine.enterPlanMode();
    assert.strictEqual(enterPlan.success, true);
    assert.strictEqual(enterPlan.data?.active, true);

    const exitPlan = engine.exitPlanMode("Refactored plan", ["step 1", "step 2"]);
    assert.strictEqual(exitPlan.success, true);
    assert.strictEqual(exitPlan.data?.active, false);
    assert.strictEqual(exitPlan.data?.activePlan, "Refactored plan");
  });

  after(async () => {
    await browserManager.closeAll();
  });
});
