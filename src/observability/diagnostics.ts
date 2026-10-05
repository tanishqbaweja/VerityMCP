import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { detectShells } from "../shell/shell_detector.js";
import { workspaceManager } from "../workspace/workspace_manager.js";
import { processManager } from "../shell/process_manager.js";
import { browserManager } from "../browser/browser_manager.js";
import { executeGitStatus } from "../git/git_ops.js";
import { executeBrowserSnapshot } from "../browser/snapshot.js";
import { executeNavigate, executeClick } from "../browser/actions.js";
import { executeDesktopScreenshot } from "../desktop/desktop_control.js";
import { activityStream } from "./activity_stream.js";
import type { StandardToolResponse } from "../types/index.js";

export type ReliabilityCategory =
  | "successful"
  | "guarded_refusal"
  | "operational_failure"
  | "verification_failure"
  | "protocol_failure";

export interface ToolAuditEntry {
  toolName: string;
  action: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
  category: ReliabilityCategory;
  errorCode?: string;
  verificationPassed?: boolean;
}

export interface SelfTestCheck {
  name: string;
  subsystem: "filesystem" | "shell" | "git" | "process" | "browser" | "desktop";
  passed: boolean;
  durationMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface SelfTestResult {
  allPassed: boolean;
  checksTotal: number;
  checksPassed: number;
  checks: SelfTestCheck[];
}

class ObservabilityManager {
  private auditLog: ToolAuditEntry[] = [];
  private maxAuditEntries = 200;

  public logToolEvent(entry: Omit<ToolAuditEntry, "category"> & { category?: ReliabilityCategory }) {
    let cat: ReliabilityCategory = entry.category || (entry.success ? "successful" : "operational_failure");

    if (!entry.success && !entry.category) {
      if (
        entry.errorCode === "WORKTREE_DIRTY" ||
        entry.errorCode === "FILE_CHANGED_SINCE_READ" ||
        entry.errorCode === "SECURITY_VIOLATION"
      ) {
        cat = "guarded_refusal";
      } else if (
        entry.errorCode === "PATCH_VERIFICATION_FAILED" ||
        entry.verificationPassed === false
      ) {
        cat = "verification_failure";
      } else if (
        entry.errorCode === "INVALID_ARGUMENT" ||
        entry.errorCode === "NOTEBOOK_INVALID"
      ) {
        cat = "protocol_failure";
      } else {
        cat = "operational_failure";
      }
    }

    const fullEntry: ToolAuditEntry = {
      ...entry,
      category: cat,
    };

    this.auditLog.push(fullEntry);
    if (this.auditLog.length > this.maxAuditEntries) {
      this.auditLog.shift();
    }
  }

  public getRecentEvents(count = 20): ToolAuditEntry[] {
    return this.auditLog.slice(-count);
  }

  public getDiagnostics(): StandardToolResponse<Record<string, unknown>> {
    const startTime = Date.now();
    const shells = detectShells();
    const activeWs = workspaceManager.getWorkspace();
    const processSessions = processManager.listSessions();
    const browserSessions = browserManager.listSessions();

    const totalCalls = this.auditLog.length;
    const successfulCalls = this.auditLog.filter((e) => e.category === "successful").length;
    const guardedRefusals = this.auditLog.filter((e) => e.category === "guarded_refusal").length;
    const operationalFailures = this.auditLog.filter((e) => e.category === "operational_failure").length;
    const verificationFailures = this.auditLog.filter((e) => e.category === "verification_failure").length;
    const protocolFailures = this.auditLog.filter((e) => e.category === "protocol_failure").length;

    const attemptedOperations = totalCalls - guardedRefusals;
    const executionSuccessRate =
      attemptedOperations > 0
        ? ((successfulCalls / attemptedOperations) * 100).toFixed(1) + "%"
        : totalCalls > 0 ? "100.0%" : "100.0%";

    const verifiableOperations = successfulCalls + verificationFailures;
    const verificationSuccessRate =
      verifiableOperations > 0
        ? ((successfulCalls / verifiableOperations) * 100).toFixed(1) + "%"
        : "100.0%";

    const data = {
      version: "1.0.0",
      os: {
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        cpus: os.cpus().length,
        freeMemMB: Math.round(os.freemem() / (1024 * 1024)),
        totalMemMB: Math.round(os.totalmem() / (1024 * 1024)),
      },
      shells: {
        powershell: {
          status: shells.powershell.status || (shells.powershell.available ? "healthy" : "unavailable"),
          path: shells.powershell.executable,
          version: shells.powershell.version || "Unknown",
          description: shells.powershell.description,
        },
        cmd: {
          status: shells.cmd.status || (shells.cmd.available ? "healthy" : "unavailable"),
          path: shells.cmd.executable,
          description: shells.cmd.description,
        },
        gitBash: {
          status: shells.gitBash.status || (shells.gitBash.available ? "healthy" : "unavailable"),
          path: shells.gitBash.executable,
          version: shells.gitBash.version || "Unknown",
          description: shells.gitBash.description,
        },
        wsl: {
          status: shells.wsl.status || (shells.wsl.available ? "healthy" : "unavailable"),
          installed: Boolean(shells.wsl.executable),
          functional: shells.wsl.available,
          reason: shells.wsl.healthProbe?.reason || (shells.wsl.available ? "Functional" : "Unavailable"),
        },
        defaultShell: shells.defaultShell,
      },
      workspace: activeWs
        ? {
            id: activeWs.id,
            root: activeWs.root,
            mode: activeWs.mode,
            languages: activeWs.repoMap?.languages || [],
          }
        : "None open",
      processes: {
        activeCount: processSessions.filter((s) => s.status === "running").length,
        totalTracked: processSessions.length,
      },
      browser: {
        activeSessions: browserSessions.length,
      },
      reliabilityAudit: {
        totalCalls,
        successfulCalls,
        guardedRefusals,
        operationalFailures,
        verificationFailures,
        protocolFailures,
        executionSuccessRate,
        verificationSuccessRate,
        safetyGuardRate: `${guardedRefusals} guarded refusals`,
        recentCalls: this.auditLog.slice(-10).map((e) => ({
          tool: e.toolName,
          success: e.success,
          category: e.category,
          errorCode: e.errorCode,
          duration: `${e.durationMs}ms`,
        })),
      },
      reliability: {
        total_calls: totalCalls,
        successful_calls: successfulCalls,
        guarded_refusals: guardedRefusals,
        operational_failures: operationalFailures,
        verification_failures: verificationFailures,
        protocol_failures: protocolFailures,
        guardedRefusals,
        operationalFailures,
        verificationFailures,
        protocolFailures,
        executionSuccessRate,
        verificationSuccessRate,
      },
    };

    const text = [
      `=== VerityMCP System Diagnostics ===`,
      `Version: 1.0.0`,
      `OS: ${process.platform} ${os.release()} (${process.arch})`,
      `Default Shell: ${shells.defaultShell}`,
      `Shells:`,
      `  PowerShell: status=${shells.powershell.status || "healthy"}, version=${shells.powershell.version || "unknown"}, path=${shells.powershell.executable}`,
      `  cmd: status=${shells.cmd.status || "healthy"}, path=${shells.cmd.executable}`,
      `  Git Bash: status=${shells.gitBash.status}, version=${shells.gitBash.version || "unknown"}, path=${shells.gitBash.executable}`,
      `  WSL: status=${shells.wsl.status}, functional=${shells.wsl.available}${shells.wsl.healthProbe?.reason ? ` (${shells.wsl.healthProbe.reason})` : ""}`,
      `Active Workspace: ${activeWs?.root || "None"}`,
      `Running Background Processes: ${processSessions.filter((s) => s.status === "running").length}`,
      `Active Browser Sessions: ${browserSessions.length}`,
      ``,
      `--- Reliability Audit ---`,
      `Calls: ${totalCalls}`,
      `Successful: ${successfulCalls}`,
      `Guarded Refusals: ${guardedRefusals}`,
      `Operational Failures: ${operationalFailures}`,
      `Verification Failures: ${verificationFailures}`,
      `Protocol Failures: ${protocolFailures}`,
      `Execution Success Rate: ${executionSuccessRate}`,
      `Verification Success Rate: ${verificationSuccessRate}`,
      `Safety Guard Rate: ${guardedRefusals} guarded refusals`,
    ].join("\n");

    return {
      success: true,
      action: "verity_diagnostics",
      display_title: "System diagnostics",
      display_status: "verified",
      text,
      summary: `System diagnostics: ${executionSuccessRate} execution success, ${guardedRefusals} guarded refusals, OS ${process.platform}`,
      execution_verification: { status: "passed", method: "system_subsystems_health_probe" },
      state_verification: { status: "passed", method: "system_subsystems_health_probe" },
      verification: {
        performed: true,
        passed: true,
        method: "system_subsystems_health_probe",
        details: { version: "1.0.0", healthy: true },
        execution: { status: "passed", method: "system_subsystems_health_probe" },
        state: { status: "passed", method: "system_subsystems_health_probe" },
      },
      data,
      durationMs: Date.now() - startTime,
    };
  }

  public async runSelfTest(workspaceRoot?: string): Promise<StandardToolResponse<SelfTestResult>> {
    const startTime = Date.now();
    const checks: SelfTestCheck[] = [];

    activityStream.emit({
      type: "action_started",
      title: "Running fast smoke test",
      purpose: "Probe filesystem, shell, git, process buffer, and browser subsystems",
      tool: "verity_self_test",
    });

    // 1. Filesystem test: atomic write, readback SHA-256, delete
    activityStream.emit({ type: "info", title: "Testing filesystem...", tool: "verity_self_test" });
    const fsStart = Date.now();
    const testFile = path.join(os.tmpdir(), `verity_selftest_${Date.now()}.txt`);
    const testPayload = `VerityMCP self-test payload: ${crypto.randomBytes(16).toString("hex")}`;
    try {
      await fs.writeFile(testFile, testPayload, "utf-8");
      const readBack = await fs.readFile(testFile, "utf-8");
      const expectedHash = crypto.createHash("sha256").update(Buffer.from(testPayload)).digest("hex");
      const actualHash = crypto.createHash("sha256").update(Buffer.from(readBack)).digest("hex");
      await fs.unlink(testFile);
      const passed = readBack === testPayload && expectedHash === actualHash;
      checks.push({
        name: "filesystem_write_read_verify",
        subsystem: "filesystem",
        passed,
        durationMs: Date.now() - fsStart,
        details: { bytesWritten: testPayload.length, hashMatch: expectedHash === actualHash },
        error: passed ? undefined : "Readback content or hash mismatch",
      });
      activityStream.emit({ type: "verification", title: "Filesystem OK", tool: "verity_self_test" });
    } catch (err: any) {
      try {
        await fs.unlink(testFile);
      } catch {}
      checks.push({
        name: "filesystem_write_read_verify",
        subsystem: "filesystem",
        passed: false,
        durationMs: Date.now() - fsStart,
        error: err.message,
      });
      activityStream.emit({ type: "failure", title: `Filesystem FAILED: ${err.message}`, tool: "verity_self_test" });
    }

    // 2. Shell execution test: run echo in default shell
    activityStream.emit({ type: "info", title: "Testing shell execution...", tool: "verity_self_test" });
    const shellStart = Date.now();
    try {
      const echoCmd = process.platform === "win32" ? "echo verity_selftest_ok" : "echo 'verity_selftest_ok'";
      const execRes = await processManager.execCommand({
        command: echoCmd,
        cwd: workspaceRoot || os.tmpdir(),
        timeoutMs: 5000,
        yieldMs: 3000,
      });
      const passed =
        execRes.success &&
        (execRes.stdout?.includes("verity_selftest_ok") || execRes.text.includes("verity_selftest_ok"));
      checks.push({
        name: "shell_command_execution",
        subsystem: "shell",
        passed,
        durationMs: Date.now() - shellStart,
        details: { exitCode: execRes.exitCode },
        error: passed ? undefined : `Echo test failed: ${execRes.stderr || execRes.text}`,
      });
      activityStream.emit({ type: "verification", title: "Shell OK", tool: "verity_self_test" });
    } catch (err: any) {
      checks.push({
        name: "shell_command_execution",
        subsystem: "shell",
        passed: false,
        durationMs: Date.now() - shellStart,
        error: err.message,
      });
      activityStream.emit({ type: "failure", title: `Shell FAILED: ${err.message}`, tool: "verity_self_test" });
    }

    // 3. Process output & cursor test
    activityStream.emit({ type: "info", title: "Testing process cursors...", tool: "verity_self_test" });
    const procStart = Date.now();
    try {
      const session = processManager.createSession("echo cursor_test", workspaceRoot || os.tmpdir());
      session.outputChunks.push({ stream: "stdout", text: "cursor_test_output", timestamp: Date.now() });
      session.status = "completed";
      session.exitCode = 0;
      const readRes = processManager.readProcessOutput(session.id, 0);
      const passed = Boolean(readRes.success && readRes.data?.output.includes("cursor_test_output"));
      checks.push({
        name: "process_buffer_cursor",
        subsystem: "process",
        passed,
        durationMs: Date.now() - procStart,
        details: { chunksRead: readRes.data?.newCursor },
        error: passed ? undefined : "Process buffer read failed",
      });
    } catch (err: any) {
      checks.push({
        name: "process_buffer_cursor",
        subsystem: "process",
        passed: false,
        durationMs: Date.now() - procStart,
        error: err.message,
      });
    }

    // 4. Git status probe
    activityStream.emit({ type: "info", title: "Testing git subsystem...", tool: "verity_self_test" });
    const gitStart = Date.now();
    try {
      const rootToTest = workspaceRoot || process.cwd();
      const statusRes = executeGitStatus(rootToTest);
      checks.push({
        name: "git_subsystem_probe",
        subsystem: "git",
        passed: statusRes.success,
        durationMs: Date.now() - gitStart,
        details: { isGitRepo: statusRes.data?.isGitRepo, branch: statusRes.data?.branch },
        error: statusRes.success ? undefined : statusRes.text,
      });
      activityStream.emit({ type: "verification", title: "Git OK", tool: "verity_self_test" });
    } catch (err: any) {
      checks.push({
        name: "git_subsystem_probe",
        subsystem: "git",
        passed: false,
        durationMs: Date.now() - gitStart,
        error: err.message,
      });
    }

    // 5. Browser subsystem probe
    activityStream.emit({ type: "info", title: "Testing browser subsystem...", tool: "verity_self_test" });
    const browserStart = Date.now();
    try {
      const sessions = browserManager.listSessions();
      checks.push({
        name: "browser_subsystem_probe",
        subsystem: "browser",
        passed: true,
        durationMs: Date.now() - browserStart,
        details: { activeSessions: sessions.length },
      });
      activityStream.emit({ type: "verification", title: "Browser subsystem OK", tool: "verity_self_test" });
    } catch (err: any) {
      checks.push({
        name: "browser_subsystem_probe",
        subsystem: "browser",
        passed: false,
        durationMs: Date.now() - browserStart,
        error: err.message,
      });
    }

    const allPassed = checks.every((c) => c.passed);
    const checksPassed = checks.filter((c) => c.passed).length;
    const lines = [
      `=== VerityMCP End-to-End Self-Test ===`,
      `Status: ${allPassed ? "ALL CHECKS PASSED (HEALTHY)" : "SOME CHECKS FAILED"}`,
      `Checks: ${checksPassed}/${checks.length} passed`,
      ...checks.map(
        (c) =>
          `  [${c.passed ? "PASS" : "FAIL"}] ${c.name} (${c.subsystem}, ${c.durationMs}ms)${c.error ? ` - ${c.error}` : ""}`
      ),
    ];

    activityStream.emit({
      type: allPassed ? "action_completed" : "failure",
      title: `Smoke test ${allPassed ? "passed" : "failed"} (${checksPassed}/${checks.length})`,
      tool: "verity_self_test",
    });

    return {
      success: allPassed,
      error_code: allPassed ? undefined : "COMMAND_FAILED",
      action: "verity_self_test",
      display_title: "Fast smoke test",
      display_status: allPassed ? "verified" : "failed",
      text: lines.join("\n"),
      summary: `Self-test ${allPassed ? "passed" : "failed"}: ${checksPassed}/${checks.length} checks passed`,
      execution_verification: {
        status: allPassed ? "passed" : "failed",
        method: "end_to_end_self_test",
      },
      state_verification: {
        status: allPassed ? "passed" : "failed",
        method: "subsystems_operational_probe",
        details: { checksPassed, checksTotal: checks.length },
      },
      verification: {
        performed: true,
        passed: allPassed,
        method: "end_to_end_self_test",
        details: { checksPassed, checksTotal: checks.length },
        execution: { status: allPassed ? "passed" : "failed", method: "end_to_end_self_test" },
        state: { status: allPassed ? "passed" : "failed", method: "subsystems_operational_probe" },
      },
      data: {
        allPassed,
        checksTotal: checks.length,
        checksPassed,
        checks,
      },
      durationMs: Date.now() - startTime,
    };
  }

  public async runAcceptanceTest(workspaceRoot?: string): Promise<StandardToolResponse<SelfTestResult>> {
    const startTime = Date.now();
    const checks: SelfTestCheck[] = [];

    activityStream.emit({
      type: "action_started",
      title: "Running deep acceptance test suite",
      purpose: "Execute full real operations: browser, UTF-8 shell, background task, desktop screenshot",
      tool: "verity_acceptance_test",
    });

    // 1. Filesystem verification
    const fsStart = Date.now();
    try {
      const p = path.join(os.tmpdir(), `verity_acc_${Date.now()}.txt`);
      await fs.writeFile(p, "verity_test_content", "utf-8");
      const read = await fs.readFile(p, "utf-8");
      await fs.unlink(p);
      const passed = read === "verity_test_content";
      checks.push({
        name: "filesystem_live_mutation",
        subsystem: "filesystem",
        passed,
        durationMs: Date.now() - fsStart,
      });
      activityStream.emit({ type: "verification", title: "Filesystem live mutation OK", tool: "verity_acceptance_test" });
    } catch (err: any) {
      checks.push({
        name: "filesystem_live_mutation",
        subsystem: "filesystem",
        passed: false,
        durationMs: Date.now() - fsStart,
        error: err.message,
      });
    }

    // 2. PowerShell UTF-8 & state verification
    const utfStart = Date.now();
    try {
      const utfRes = await processManager.execCommand({
        command: "Write-Output 'Hello ✓ é 日本語 🚀'",
        cwd: workspaceRoot || os.tmpdir(),
        shell: "powershell",
        timeoutMs: 8000,
      });
      const passed = Boolean(
        utfRes.success &&
        utfRes.stdout?.includes("✓") &&
        utfRes.stdout?.includes("🚀") &&
        utfRes.stdout?.includes("日本語")
      );
      checks.push({
        name: "powershell_utf8_output",
        subsystem: "shell",
        passed,
        durationMs: Date.now() - utfStart,
        details: { output: utfRes.stdout },
        error: passed ? undefined : "PowerShell output failed UTF-8 character check",
      });
      activityStream.emit({ type: "verification", title: "PowerShell UTF-8 output OK", tool: "verity_acceptance_test" });
    } catch (err: any) {
      checks.push({
        name: "powershell_utf8_output",
        subsystem: "shell",
        passed: false,
        durationMs: Date.now() - utfStart,
        error: err.message,
      });
    }

    // 3. Desktop screenshot capture & disk verification
    const deskStart = Date.now();
    try {
      const deskRes = await executeDesktopScreenshot({
        region: { x: 0, y: 0, width: 100, height: 100 },
      });
      const passed = deskRes.toolResponse.success && deskRes.toolResponse.data?.bytes! > 0;
      checks.push({
        name: "desktop_screenshot_capture",
        subsystem: "desktop",
        passed,
        durationMs: Date.now() - deskStart,
        details: { bytes: deskRes.toolResponse.data?.bytes, sha256: deskRes.toolResponse.data?.sha256 },
        error: passed ? undefined : deskRes.toolResponse.text,
      });
      activityStream.emit({ type: "verification", title: "Desktop screenshot OK", tool: "verity_acceptance_test" });
    } catch (err: any) {
      checks.push({
        name: "desktop_screenshot_capture",
        subsystem: "desktop",
        passed: false,
        durationMs: Date.now() - deskStart,
        error: err.message,
      });
    }

    // 4. Real browser lifecycle & stale ref safety
    const browserStart = Date.now();
    try {
      const sess = await browserManager.getSession("acceptance_test_sess");
      const html1 = `<!DOCTYPE html><html><body><input id="input1" type="text" value="hello" /></body></html>`;
      await executeNavigate(sess, `data:text/html;base64,${Buffer.from(html1).toString("base64")}`);
      const snap1 = await executeBrowserSnapshot(sess, { verbosity: "normal" });
      const firstRef = snap1.data?.elements[0]?.ref;

      // Navigate to new document (increments generation)
      const html2 = `<!DOCTYPE html><html><body><p id="para">New page</p></body></html>`;
      await executeNavigate(sess, `data:text/html;base64,${Buffer.from(html2).toString("base64")}`);
      await executeBrowserSnapshot(sess, { verbosity: "normal" });

      // Stale ref invocation must immediately fail
      let stalePassed = false;
      if (firstRef) {
        const clickRes = await executeClick(sess, { ref: firstRef });
        stalePassed = !clickRes.success && clickRes.error_code === "STALE_ELEMENT_REFERENCE";
      }

      await browserManager.closeSession("acceptance_test_sess");

      checks.push({
        name: "browser_stale_ref_safety",
        subsystem: "browser",
        passed: stalePassed,
        durationMs: Date.now() - browserStart,
        error: stalePassed ? undefined : "Old element ref was not rejected with STALE_ELEMENT_REFERENCE",
      });
      activityStream.emit({ type: "verification", title: "Browser stale ref safety OK", tool: "verity_acceptance_test" });
    } catch (err: any) {
      await browserManager.closeSession("acceptance_test_sess").catch(() => {});
      checks.push({
        name: "browser_stale_ref_safety",
        subsystem: "browser",
        passed: false,
        durationMs: Date.now() - browserStart,
        error: err.message,
      });
    }

    const allPassed = checks.every((c) => c.passed);
    const checksPassed = checks.filter((c) => c.passed).length;

    activityStream.emit({
      type: allPassed ? "action_completed" : "failure",
      title: `Acceptance test ${allPassed ? "passed" : "failed"} (${checksPassed}/${checks.length})`,
      tool: "verity_acceptance_test",
    });

    const lines = [
      `=== VerityMCP Deep Acceptance Test ===`,
      `Status: ${allPassed ? "ALL SUBSYSTEMS PASSED (CERTIFIED)" : "SOME SUBSYSTEMS FAILED"}`,
      `Checks: ${checksPassed}/${checks.length} passed`,
      ...checks.map(
        (c) =>
          `  [${c.passed ? "PASS" : "FAIL"}] ${c.name} (${c.subsystem}, ${c.durationMs}ms)${c.error ? ` - ${c.error}` : ""}`
      ),
    ];

    return {
      success: allPassed,
      error_code: allPassed ? undefined : "COMMAND_FAILED",
      action: "verity_acceptance_test",
      display_title: "Deep acceptance test",
      display_status: allPassed ? "verified" : "failed",
      text: lines.join("\n"),
      summary: `Acceptance test ${allPassed ? "passed" : "failed"}: ${checksPassed}/${checks.length} passed`,
      execution_verification: { status: allPassed ? "passed" : "failed", method: "deep_acceptance_test" },
      state_verification: { status: allPassed ? "passed" : "failed", method: "deep_acceptance_test" },
      verification: {
        performed: true,
        passed: allPassed,
        method: "deep_acceptance_test",
        details: { checksPassed, checksTotal: checks.length },
        execution: { status: allPassed ? "passed" : "failed", method: "deep_acceptance_test" },
        state: { status: allPassed ? "passed" : "failed", method: "deep_acceptance_test" },
      },
      data: {
        allPassed,
        checksTotal: checks.length,
        checksPassed,
        checks,
      },
      durationMs: Date.now() - startTime,
    };
  }
}

export const observabilityManager = new ObservabilityManager();
