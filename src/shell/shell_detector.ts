import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { DetectedShells, ShellInfo, ShellType } from "../types/index.js";

let cachedShells: DetectedShells | null = null;

function fileExists(filePath?: string): boolean {
  if (!filePath) return false;
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function probeExecutable(
  executable: string,
  args: string[],
  expectedSubstring?: string
): { success: boolean; output: string } {
  try {
    const output = execFileSync(executable, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2500,
      windowsHide: true,
    }).trim();
    if (expectedSubstring && !output.includes(expectedSubstring)) {
      return { success: false, output };
    }
    return { success: true, output };
  } catch (err: any) {
    return { success: false, output: err.message || "" };
  }
}

function findGitBashExecutable(): {
  executable: string;
  description: string;
  version?: string;
  healthy: boolean;
} | null {
  const isWin = process.platform === "win32";
  if (!isWin) {
    const probe = probeExecutable("bash", ["-c", "printf ok"], "ok");
    if (probe.success) {
      const verProbe = probeExecutable("bash", ["--version"]);
      return {
        executable: "bash",
        description: "POSIX Bash",
        version: verProbe.output.split(/\r?\n/)[0],
        healthy: true,
      };
    }
    return null;
  }

  const drives = ["C", "D", "E", "F", "G", "H"];
  const staticCandidates: string[] = [];

  for (const d of drives) {
    staticCandidates.push(`${d}:\\Program Files\\Git\\bin\\bash.exe`);
    staticCandidates.push(`${d}:\\Program Files\\Git\\usr\\bin\\bash.exe`);
    staticCandidates.push(`${d}:\\Program Files (x86)\\Git\\bin\\bash.exe`);
    staticCandidates.push(`${d}:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe`);
    staticCandidates.push(`${d}:\\Git\\bin\\bash.exe`);
    staticCandidates.push(`${d}:\\Git\\usr\\bin\\bash.exe`);
    staticCandidates.push(`${d}:\\msys64\\usr\\bin\\bash.exe`);
    staticCandidates.push(`${d}:\\cygwin64\\bin\\bash.exe`);
  }

  if (process.env.LOCALAPPDATA) {
    staticCandidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
    staticCandidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Git", "usr", "bin", "bash.exe"));
  }
  if (process.env.PROGRAMW6432) {
    staticCandidates.push(path.join(process.env.PROGRAMW6432, "Git", "bin", "bash.exe"));
    staticCandidates.push(path.join(process.env.PROGRAMW6432, "Git", "usr", "bin", "bash.exe"));
  }

  // Also query `where.exe git` to infer Git Bash location
  try {
    const whereGit = execFileSync("where.exe", ["git"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    })
      .trim()
      .split(/\r?\n/);
    for (const gPath of whereGit) {
      if (fileExists(gPath)) {
        const dir = path.dirname(gPath);
        staticCandidates.push(path.resolve(dir, "..", "bin", "bash.exe"));
        staticCandidates.push(path.resolve(dir, "..", "usr", "bin", "bash.exe"));
      }
    }
  } catch {}

  // Also query `where.exe bash` (ignoring System32 WSL shim)
  try {
    const whereBash = execFileSync("where.exe", ["bash"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    })
      .trim()
      .split(/\r?\n/);
    for (const bPath of whereBash) {
      if (!bPath.toLowerCase().includes("system32") && fileExists(bPath)) {
        staticCandidates.push(bPath);
      }
    }
  } catch {}

  const tested = new Set<string>();
  for (const cand of staticCandidates) {
    if (!cand || tested.has(cand.toLowerCase())) continue;
    tested.add(cand.toLowerCase());

    if (fileExists(cand)) {
      const probe = probeExecutable(cand, ["-c", "printf ok"], "ok");
      if (probe.success) {
        const verProbe = probeExecutable(cand, ["--version"]);
        const verLine = verProbe.output.split(/\r?\n/)[0] || "Git Bash";
        const desc = cand.includes("msys64")
          ? "MSYS2 Bash"
          : cand.includes("cygwin")
          ? "Cygwin Bash"
          : "Git Bash (MSYS)";
        return {
          executable: cand,
          description: desc,
          version: verLine,
          healthy: true,
        };
      }
    }
  }

  return null;
}

function probeWsl(): {
  available: boolean;
  functional: boolean;
  distro?: string;
  reason?: string;
  bashAvailable: boolean;
} {
  const isWin = process.platform === "win32";
  if (!isWin) {
    return { available: false, functional: false, bashAvailable: false, reason: "Non-Windows OS" };
  }

  try {
    const wslExe = "C:\\Windows\\System32\\wsl.exe";
    if (!fileExists(wslExe)) {
      return { available: false, functional: false, bashAvailable: false, reason: "wsl.exe not found" };
    }

    const distrosOut = execFileSync(wslExe, ["-l", "-q"], {
      encoding: "utf-16le",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();

    if (!distrosOut) {
      return { available: false, functional: false, bashAvailable: false, reason: "No WSL distros installed" };
    }

    const distros = distrosOut.split(/\r?\n/).map((d) => d.trim()).filter(Boolean);
    const defaultDistro = distros[0] || "unknown";

    // Test if bash is actually installed and functional in the default distro
    try {
      const bashProbe = execFileSync(wslExe, ["bash", "-c", "printf ok"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 2500,
      }).trim();

      if (bashProbe === "ok") {
        return {
          available: true,
          functional: true,
          distro: defaultDistro,
          bashAvailable: true,
        };
      }
    } catch {
      return {
        available: false,
        functional: false,
        distro: defaultDistro,
        bashAvailable: false,
        reason: `WSL default distro (${defaultDistro}) has no functional /bin/bash`,
      };
    }

    return {
      available: false,
      functional: false,
      distro: defaultDistro,
      bashAvailable: false,
      reason: "WSL bash probe did not return expected output",
    };
  } catch (err: any) {
    return {
      available: false,
      functional: false,
      bashAvailable: false,
      reason: err.message || "WSL detection error",
    };
  }
}

/**
 * Probes for available shells on the system with verified health checks.
 */
export function detectShells(forceRefresh = false): DetectedShells {
  if (cachedShells && !forceRefresh) {
    return cachedShells;
  }

  const isWin = process.platform === "win32";

  // 1. PowerShell Detection & Probe
  let psExe = "powershell";
  let psAvailable = false;
  let psDesc = "PowerShell";
  let psVer = "";
  let psHealthy = false;

  if (isWin) {
    const pwsh7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const winPs = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

    if (fileExists(pwsh7)) {
      psExe = pwsh7;
      psDesc = "PowerShell 7 (Core)";
    } else if (fileExists(winPs)) {
      psExe = winPs;
      psDesc = "Windows PowerShell 5.1";
    }

    const psProbe = probeExecutable(psExe, ["-NoProfile", "-Command", "Write-Output ok"], "ok");
    if (psProbe.success) {
      psAvailable = true;
      psHealthy = true;
      try {
        const verOut = execFileSync(psExe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
        }).trim();
        psVer = verOut;
      } catch {}
    }
  } else {
    const psProbe = probeExecutable("pwsh", ["-Command", "Write-Output ok"], "ok");
    if (psProbe.success) {
      psExe = "pwsh";
      psAvailable = true;
      psHealthy = true;
      psDesc = "PowerShell Core";
    }
  }

  const powershellInfo: ShellInfo = {
    type: "powershell",
    available: psAvailable,
    executable: psExe,
    description: psDesc,
    version: psVer || undefined,
    status: psHealthy ? "healthy" : "unavailable",
    healthProbe: {
      healthy: psHealthy,
      version: psVer,
    },
  };

  // 2. CMD Detection & Probe
  const cmdExe = process.env.COMSPEC || (isWin ? "C:\\Windows\\System32\\cmd.exe" : "sh");
  const cmdAvailable = isWin ? fileExists(cmdExe) : false;
  const cmdInfo: ShellInfo = {
    type: "cmd",
    available: cmdAvailable,
    executable: cmdExe,
    description: "Windows Command Prompt (cmd.exe)",
    status: cmdAvailable ? "healthy" : "unavailable",
    healthProbe: {
      healthy: cmdAvailable,
    },
  };

  // 3. Git Bash / POSIX Bash Detection & Probe
  const gitBashFound = findGitBashExecutable();
  const gitBashInfo: ShellInfo = {
    type: "git-bash",
    available: Boolean(gitBashFound?.healthy),
    executable: gitBashFound?.executable || (isWin ? "" : "bash"),
    description: gitBashFound?.description || (isWin ? "Git Bash (Not installed)" : "POSIX Bash"),
    version: gitBashFound?.version,
    status: gitBashFound?.healthy ? "healthy" : "unavailable",
    healthProbe: {
      healthy: Boolean(gitBashFound?.healthy),
      version: gitBashFound?.version,
    },
  };

  // 4. WSL Bash Detection (Strict health check)
  const wslResult = probeWsl();
  const wslInfo: ShellInfo = {
    type: "wsl",
    available: wslResult.available,
    executable: "wsl.exe",
    description: wslResult.available
      ? `WSL Bash (${wslResult.distro})`
      : `WSL (${wslResult.reason || "Not functional"})`,
    status: wslResult.available ? "healthy" : "unavailable",
    healthProbe: {
      healthy: wslResult.available,
      reason: wslResult.reason,
    },
  };

  // Determine intelligent default shell
  let defaultShell: ShellType = "powershell";
  if (isWin) {
    defaultShell = gitBashInfo.available ? "bash" : "powershell";
  } else {
    defaultShell = "bash";
  }

  cachedShells = {
    powershell: powershellInfo,
    cmd: cmdInfo,
    gitBash: gitBashInfo,
    wsl: wslInfo,
    defaultShell,
  };

  return cachedShells;
}

/**
 * Resolves the executable and arguments prefix for a requested shell type.
 * Accurately routes bash and git-bash to real Git Bash on Windows.
 */
export function resolveShellCommand(requested?: ShellType | string): {
  shell: string;
  argsPrefix: string[];
  shellType: ShellType;
  description: string;
} {
  const shells = detectShells();
  const req = (requested?.toLowerCase() || shells.defaultShell) as ShellType;

  if (req === "powershell") {
    if (!shells.powershell.available && process.platform === "win32") {
      throw new Error("PowerShell is not available on this system.");
    }
    return {
      shell: shells.powershell.executable,
      argsPrefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
      shellType: "powershell",
      description: shells.powershell.description,
    };
  }

  if (req === "cmd") {
    if (!shells.cmd.available) {
      throw new Error("cmd.exe is not available on this system.");
    }
    return {
      shell: shells.cmd.executable,
      argsPrefix: ["/d", "/s", "/c"],
      shellType: "cmd",
      description: shells.cmd.description,
    };
  }

  if (req === "git-bash") {
    if (shells.gitBash.available) {
      return {
        shell: shells.gitBash.executable,
        argsPrefix: ["-c"],
        shellType: "git-bash",
        description: shells.gitBash.description,
      };
    }
    throw new Error(
      `BASH_NOT_AVAILABLE: Git Bash was not found on this Windows system.\n` +
      `Detected shells:\n` +
      `- PowerShell: ${shells.powershell.available ? "available" : "unavailable"}\n` +
      `- cmd: ${shells.cmd.available ? "available" : "unavailable"}\n` +
      `- WSL: ${shells.wsl.available ? "available" : "unavailable"}`
    );
  }

  if (req === "wsl") {
    if (!shells.wsl.available) {
      const reason = shells.wsl.healthProbe?.reason || "WSL is not functional or lacks /bin/bash.";
      throw new Error(`WSL_UNAVAILABLE: ${reason}`);
    }
    return {
      shell: "wsl.exe",
      argsPrefix: ["bash", "-c"],
      shellType: "wsl",
      description: shells.wsl.description,
    };
  }

  if (req === "bash") {
    // 1. Git Bash on Windows (preferred)
    if (shells.gitBash.available) {
      return {
        shell: shells.gitBash.executable,
        argsPrefix: ["-c"],
        shellType: "git-bash",
        description: shells.gitBash.description,
      };
    }

    // 2. WSL only if genuinely functional with bash
    if (shells.wsl.available) {
      return {
        shell: "wsl.exe",
        argsPrefix: ["bash", "-c"],
        shellType: "wsl",
        description: shells.wsl.description,
      };
    }

    // 3. POSIX bash on Linux/macOS
    if (process.platform !== "win32") {
      return {
        shell: "bash",
        argsPrefix: ["-c"],
        shellType: "bash",
        description: "POSIX Bash",
      };
    }

    // None available on Windows
    throw new Error(
      `BASH_NOT_AVAILABLE: No functional Bash provider found on this Windows machine.\n` +
      `Git Bash was not found and WSL has no functional bash distribution.\n` +
      `Detected shells:\n` +
      `- PowerShell: ${shells.powershell.available ? "available" : "unavailable"} (${shells.powershell.description})\n` +
      `- cmd.exe: ${shells.cmd.available ? "available" : "unavailable"}\n` +
      `- Git Bash: unavailable\n` +
      `- WSL: unavailable (${shells.wsl.healthProbe?.reason || "no bash"})\n` +
      `To execute commands on Windows, use shell: "powershell" or shell: "cmd".`
    );
  }

  return resolveShellCommand(shells.defaultShell);
}
