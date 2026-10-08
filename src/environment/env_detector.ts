import { execFileSync } from "node:child_process";
import os from "node:os";
import { detectShells } from "../shell/shell_detector.js";
import type { StandardToolResponse } from "../types/index.js";

export interface ToolVersionInfo {
  installed: boolean;
  version?: string;
}

export interface EnvironmentReport {
  os: {
    platform: string;
    release: string;
    arch: string;
    cpus: number;
    memoryGB: number;
  };
  shells: ReturnType<typeof detectShells>;
  tools: Record<string, ToolVersionInfo>;
  cachedAt: number;
}

let cachedEnv: EnvironmentReport | null = null;

function probeTool(executable: string, args: string[]): ToolVersionInfo {
  try {
    const out = execFileSync(executable, args, {
      encoding: "utf-8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const firstLine = out.split(/\r?\n/)[0]?.slice(0, 50) || "installed";
    return { installed: true, version: firstLine };
  } catch {
    return { installed: false };
  }
}

export function detectEnvironment(forceRefresh = false): StandardToolResponse<EnvironmentReport> {
  const startTime = Date.now();
  if (cachedEnv && !forceRefresh) {
    return {
      success: true,
      action: "get_environment",
      text: formatEnvReport(cachedEnv),
      verification: { performed: true, passed: true, method: "environment_cache_hit" },
      data: cachedEnv,
      durationMs: Date.now() - startTime,
    };
  }

  const shells = detectShells();
  const tools: Record<string, ToolVersionInfo> = {
    node: probeTool("node", ["-v"]),
    pnpm: probeTool("pnpm", ["-v"]),
    npm: probeTool("npm", ["-v"]),
    yarn: probeTool("yarn", ["-v"]),
    bun: probeTool("bun", ["-v"]),
    python: probeTool("python", ["--version"]),
    uv: probeTool("uv", ["--version"]),
    git: probeTool("git", ["--version"]),
    gh: probeTool("gh", ["--version"]),
    docker: probeTool("docker", ["--version"]),
    dotnet: probeTool("dotnet", ["--version"]),
    java: probeTool("java", ["-version"]),
  };

  const report: EnvironmentReport = {
    os: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      cpus: os.cpus().length,
      memoryGB: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
    },
    shells,
    tools,
    cachedAt: Date.now(),
  };

  cachedEnv = report;

  return {
    success: true,
    action: "get_environment",
    text: formatEnvReport(report),
    verification: { performed: true, passed: true, method: "system_probe" },
    data: report,
    durationMs: Date.now() - startTime,
  };
}

function formatEnvReport(report: EnvironmentReport): string {
  const installedTools = Object.entries(report.tools)
    .filter(([_, info]) => info.installed)
    .map(([name, info]) => `${name}: ${info.version || "yes"}`);

  const bashResolution = report.shells.gitBash.available
    ? `git-bash (${report.shells.gitBash.executable})`
    : report.shells.wsl.available
    ? `wsl (${report.shells.wsl.executable})`
    : "unavailable";

  return [
    `=== Environment Profile ===`,
    `OS: ${report.os.platform} ${report.os.release} (${report.os.arch}, ${report.os.cpus} CPUs, ${report.os.memoryGB} GB RAM)`,
    `Default Shell: ${report.shells.defaultShell}`,
    `Bash alias resolves to: ${bashResolution}`,
    `Shells:`,
    `  powershell: ${report.shells.powershell.status || (report.shells.powershell.available ? "healthy" : "unavailable")} (${report.shells.powershell.description})`,
    `  cmd: ${report.shells.cmd.status || (report.shells.cmd.available ? "healthy" : "unavailable")}`,
    `  git-bash: ${report.shells.gitBash.status || (report.shells.gitBash.available ? "healthy" : "unavailable")} (${report.shells.gitBash.description})`,
    `  wsl: ${report.shells.wsl.status || (report.shells.wsl.available ? "healthy" : "unavailable")}${report.shells.wsl.healthProbe?.reason ? ` (${report.shells.wsl.healthProbe.reason})` : ""}`,
    `Detected Dev Tools (${installedTools.length}):`,
    ...installedTools.map((t) => `  - ${t}`),
  ].join("\n");
}
