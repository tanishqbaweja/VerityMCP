import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
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

/**
 * Probes for available shells on the system with Windows-first intelligence.
 */
export function detectShells(forceRefresh = false): DetectedShells {
  if (cachedShells && !forceRefresh) {
    return cachedShells;
  }

  const isWin = process.platform === "win32";

  // 1. PowerShell Detection
  let psExe = "powershell";
  let psAvailable = false;
  let psDesc = "PowerShell";

  if (isWin) {
    const pwsh7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const winPs = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

    if (fileExists(pwsh7)) {
      psExe = pwsh7;
      psAvailable = true;
      psDesc = "PowerShell 7 (Core)";
    } else if (fileExists(winPs)) {
      psExe = winPs;
      psAvailable = true;
      psDesc = "Windows PowerShell 5.1";
    } else {
      try {
        execSync("powershell -NoProfile -Command \"$PSVersionTable.PSVersion\"", { stdio: "ignore" });
        psAvailable = true;
      } catch {}
    }
  } else {
    try {
      execSync("which pwsh", { stdio: "ignore" });
      psExe = "pwsh";
      psAvailable = true;
      psDesc = "PowerShell Core";
    } catch {}
  }

  const powershellInfo: ShellInfo = {
    type: "powershell",
    available: psAvailable,
    executable: psExe,
    description: psDesc,
  };

  // 2. CMD Detection
  const cmdExe = process.env.COMSPEC || (isWin ? "C:\\Windows\\System32\\cmd.exe" : "sh");
  const cmdAvailable = isWin ? fileExists(cmdExe) : false;
  const cmdInfo: ShellInfo = {
    type: "cmd",
    available: cmdAvailable,
    executable: cmdExe,
    description: "Windows Command Prompt (cmd.exe)",
  };

  // 3. Git Bash / Native POSIX Bash Detection
  let gitBashExe = "";
  let gitBashAvailable = false;
  let gitBashDesc = "Git Bash";

  if (isWin) {
    const gitBashCandidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      "C:\\Git\\bin\\bash.exe",
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe")
        : "",
      "C:\\msys64\\usr\\bin\\bash.exe",
      "C:\\cygwin64\\bin\\bash.exe",
    ].filter(Boolean);

    for (const cand of gitBashCandidates) {
      if (fileExists(cand)) {
        gitBashExe = cand;
        gitBashAvailable = true;
        gitBashDesc = cand.includes("msys64")
          ? "MSYS2 Bash"
          : cand.includes("cygwin")
          ? "Cygwin Bash"
          : "Git Bash (MSYS)";
        break;
      }
    }

    if (!gitBashAvailable) {
      // Check if `where.exe bash` points to a git installation rather than System32
      try {
        const whereOut = execSync("where.exe bash", { encoding: "utf-8" }).trim().split(/\r?\n/);
        for (const outPath of whereOut) {
          if (!outPath.toLowerCase().includes("system32") && fileExists(outPath)) {
            gitBashExe = outPath;
            gitBashAvailable = true;
            gitBashDesc = "Bash (from PATH)";
            break;
          }
        }
      } catch {}
    }
  } else {
    try {
      execSync("which bash", { stdio: "ignore" });
      gitBashExe = "bash";
      gitBashAvailable = true;
      gitBashDesc = "POSIX Bash";
    } catch {}
  }

  const gitBashInfo: ShellInfo = {
    type: "git-bash",
    available: gitBashAvailable,
    executable: gitBashExe,
    description: gitBashDesc,
  };

  // 4. WSL Bash Detection (Strict - do NOT assume working)
  let wslAvailable = false;
  let wslDesc = "WSL (Not installed/running)";

  if (isWin) {
    try {
      // Check if wsl.exe exists and returns installed distros without error
      const wslList = execSync("wsl.exe -l -q", { encoding: "utf-16le", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 });
      if (wslList && wslList.trim().length > 0) {
        wslAvailable = true;
        wslDesc = "Windows Subsystem for Linux (WSL)";
      }
    } catch {
      wslAvailable = false;
    }
  }

  const wslInfo: ShellInfo = {
    type: "wsl",
    available: wslAvailable,
    executable: "wsl.exe",
    description: wslDesc,
  };

  // Determine intelligent default shell
  let defaultShell: ShellType = "powershell";
  if (isWin) {
    defaultShell = gitBashAvailable ? "bash" : "powershell";
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
 * Never silently invokes WSL when bash is requested.
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

  if (req === "bash" || req === "git-bash") {
    if (shells.gitBash.available) {
      return {
        shell: shells.gitBash.executable,
        argsPrefix: ["-c"],
        shellType: "git-bash",
        description: shells.gitBash.description,
      };
    }

    if (process.platform === "win32") {
      // If WSL is genuinely verified available
      if (shells.wsl.available) {
        return {
          shell: "wsl.exe",
          argsPrefix: ["bash", "-c"],
          shellType: "wsl",
          description: "WSL Bash (verified distro)",
        };
      }

      // DO NOT crash with WSL CreateProcess error! Fail cleanly with actionable help!
      throw new Error(
        `BASH_NOT_AVAILABLE: No Bash installation found on this Windows machine. ` +
        `Git Bash was not found in Program Files or LocalAppData, and WSL has no initialized distributions.\n` +
        `Available shells on this machine:\n` +
        `- PowerShell (${shells.powershell.description})\n` +
        `- cmd.exe (${shells.cmd.description})\n` +
        `To execute commands on Windows, use shell: "powershell" or shell: "cmd".`
      );
    }

    return {
      shell: "bash",
      argsPrefix: ["-c"],
      shellType: "bash",
      description: "POSIX Bash",
    };
  }

  if (req === "wsl") {
    if (!shells.wsl.available) {
      throw new Error("WSL is not available or has no registered Linux distributions.");
    }
    return {
      shell: "wsl.exe",
      argsPrefix: ["bash", "-c"],
      shellType: "wsl",
      description: "WSL Bash",
    };
  }

  // Fallback to default
  return resolveShellCommand(shells.defaultShell);
}
