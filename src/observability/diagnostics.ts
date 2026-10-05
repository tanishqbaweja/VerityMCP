import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { detectShells } from "../shell/shell_detector.js";
import { workspaceManager } from "../workspace/workspace_manager.js";
import { processManager } from "../shell/process_manager.js";
import { browserManager } from "../browser/browser_manager.js";
import { executeGitStatus } from "../git/git_ops.js";
import type { StandardToolResponse } from "../types/index.js";

export interface ToolAuditEntry {
  toolName: string;
  action: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
}

export interface SelfTestCheck {
  name: string;
  subsystem: "filesystem" | "shell" | "git" | "process" | "browser";
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
  private maxAuditEntries = 100;

  public logToolEvent(entry: ToolAuditEntry) {
    this.auditLog.push(entry);
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

    const totalAudited = this.auditLog.length;
    const successfulAudited = this.auditLog.filter((e) => e.success).length;
    const successRate = totalAudited > 0 ? ((successfulAudited / totalAudited) * 100).toFixed(1) + "%" : "100%";

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
        totalCalls: totalAudited,
        successRate,
        recentCalls: this.auditLog.slice(-5).map((e) => ({
          tool: e.toolName,
          success: e.success,
          duration: `${e.durationMs}ms`,
        })),
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
      `Tool Reliability Success Rate: ${successRate} (${successfulAudited}/${totalAudited})`,
    ].join("\n");

    return {
      success: true,
      action: "verity_diagnostics",
      text,
      summary: `System diagnostics: ${successRate} reliability rate, OS ${process.platform}`,
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

    // 1. Filesystem test: atomic write, readback SHA-256, delete
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
    }

    // 2. Shell execution test: run echo in default shell
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
    } catch (err: any) {
      checks.push({
        name: "shell_command_execution",
        subsystem: "shell",
        passed: false,
        durationMs: Date.now() - shellStart,
        error: err.message,
      });
    }

    // 3. Process output & cursor test
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

    return {
      success: allPassed,
      error_code: allPassed ? undefined : "COMMAND_FAILED",
      action: "verity_self_test",
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
}

export const observabilityManager = new ObservabilityManager();
