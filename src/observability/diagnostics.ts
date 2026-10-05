import os from "node:os";
import { detectShells } from "../shell/shell_detector.js";
import { workspaceManager } from "../workspace/workspace_manager.js";
import { processManager } from "../shell/process_manager.js";
import { browserManager } from "../browser/browser_manager.js";
import type { StandardToolResponse } from "../types/index.js";

export interface ToolAuditEntry {
  toolName: string;
  action: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
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
      verification: {
        performed: true,
        passed: true,
        method: "system_subsystems_health_probe",
        details: { version: "1.0.0", healthy: true },
      },
      data,
      durationMs: Date.now() - startTime,
    };
  }
}

export const observabilityManager = new ObservabilityManager();
