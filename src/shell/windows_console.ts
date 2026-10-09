import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const HOST_SOURCE = String.raw`using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class DevSpacePrivateConsoleHost {
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AllocConsole();
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    public delegate bool ConsoleCtrlHandler(uint ctrlType);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);
    static readonly ConsoleCtrlHandler HostCtrlHandler = new ConsoleCtrlHandler(ctrlType => true);

    static string QuoteArg(string arg) {
        if (arg == null) return "\"\"";
        if (arg.Length > 0 && arg.IndexOfAny(new[]{' ', '\t', '\n', '\v', '"'}) < 0) return arg;
        var sb = new StringBuilder();
        sb.Append('"');
        int slashes = 0;
        foreach (char c in arg) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') {
                sb.Append('\\', slashes * 2 + 1);
                sb.Append('"');
                slashes = 0;
                continue;
            }
            if (slashes > 0) { sb.Append('\\', slashes); slashes = 0; }
            sb.Append(c);
        }
        if (slashes > 0) sb.Append('\\', slashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    static string JoinArgs(string[] args) {
        if (args == null || args.Length == 0) return "";
        var quoted = new string[args.Length];
        for (int i = 0; i < args.Length; i++) quoted[i] = QuoteArg(args[i]);
        return string.Join(" ", quoted);
    }

    public static int Main(string[] argv) {
        if (argv == null || argv.Length != 1) {
            Console.Error.WriteLine("Expected one base64 process payload argument.");
            return 64;
        }

        string decoded = Encoding.UTF8.GetString(Convert.FromBase64String(argv[0]));
        string[] parts = decoded.Split(new[]{'\0'});
        if (parts.Length < 2) {
            Console.Error.WriteLine("Invalid process payload.");
            return 64;
        }

        string exe = parts[0];
        string cwd = parts[1];
        string[] childArgs = new string[Math.Max(0, parts.Length - 2)];
        if (childArgs.Length > 0) Array.Copy(parts, 2, childArgs, 0, childArgs.Length);

        Stream originalIn = Console.OpenStandardInput();
        Stream originalOut = Console.OpenStandardOutput();
        Stream originalErr = Console.OpenStandardError();

        FreeConsole();
        if (!AllocConsole()) {
            Console.Error.WriteLine("AllocConsole failed: " + Marshal.GetLastWin32Error());
            return 65;
        }
        IntPtr hwnd = GetConsoleWindow();
        if (hwnd != IntPtr.Zero) ShowWindow(hwnd, 0);
        if (!SetConsoleCtrlHandler(HostCtrlHandler, true)) {
            Console.Error.WriteLine("SetConsoleCtrlHandler failed: " + Marshal.GetLastWin32Error());
            return 65;
        }

        var psi = new ProcessStartInfo(exe, JoinArgs(childArgs));
        psi.WorkingDirectory = cwd;
        psi.UseShellExecute = false;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.CreateNoWindow = false;

        var child = new Process();
        child.StartInfo = psi;
        if (!child.Start()) return 127;

        Task stdoutTask = child.StandardOutput.BaseStream.CopyToAsync(originalOut);
        Task stderrTask = child.StandardError.BaseStream.CopyToAsync(originalErr);
        Task.Run(async () => {
            try { await originalIn.CopyToAsync(child.StandardInput.BaseStream); }
            catch { }
        });

        child.WaitForExit();
        try { stdoutTask.GetAwaiter().GetResult(); } catch { }
        try { stderrTask.GetAwaiter().GetResult(); } catch { }
        try { child.StandardInput.Close(); } catch { }
        return child.ExitCode;
    }
}
`;

let cachedHostPath: string | undefined;

function cacheDirectory(): string {
  const dir = path.join(os.tmpdir(), "devspace4", "windows-console-host");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureWindowsPrivateConsoleHost(): string {
  if (process.platform !== "win32") {
    throw new Error("Windows private console host is only available on win32.");
  }
  if (cachedHostPath && fs.existsSync(cachedHostPath)) return cachedHostPath;

  const hash = crypto.createHash("sha256").update(HOST_SOURCE).digest("hex").slice(0, 16);
  const dir = cacheDirectory();
  const sourcePath = path.join(dir, `host-${hash}.cs`);
  const exePath = path.join(dir, `host-${hash}.exe`);
  cachedHostPath = exePath;
  if (fs.existsSync(exePath)) return exePath;

  fs.writeFileSync(sourcePath, HOST_SOURCE, "utf8");
  const tempExe = `${exePath}.${process.pid}.building.exe`;
  try { fs.rmSync(tempExe, { force: true }); } catch {}

  const compileScript = [
    "$ErrorActionPreference='Stop'",
    "$src=Get-Content -Raw -LiteralPath $env:DEVSPACE_HOST_SOURCE",
    "Add-Type -TypeDefinition $src -Language CSharp -OutputAssembly $env:DEVSPACE_HOST_OUTPUT -OutputType ConsoleApplication",
  ].join("; ");
  const compiled = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", compileScript],
    {
      windowsHide: true,
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        DEVSPACE_HOST_SOURCE: sourcePath,
        DEVSPACE_HOST_OUTPUT: tempExe,
      },
    }
  );
  if (compiled.status !== 0 || !fs.existsSync(tempExe)) {
    cachedHostPath = undefined;
    throw new Error(`Failed compiling Windows private console host: ${(compiled.stderr || compiled.stdout || `exit ${compiled.status}`).trim()}`);
  }

  try {
    fs.renameSync(tempExe, exePath);
  } catch (err: any) {
    if (!fs.existsSync(exePath)) {
      cachedHostPath = undefined;
      throw err;
    }
    try { fs.rmSync(tempExe, { force: true }); } catch {}
  }
  return exePath;
}

export function encodeWindowsProcessPayload(executable: string, cwd: string, args: string[]): string {
  return Buffer.from([executable, cwd, ...args].join("\0"), "utf8").toString("base64");
}

export function sendWindowsPrivateConsoleCtrlC(pid: number): { success: boolean; error?: string } {
  if (process.platform !== "win32") return { success: false, error: "Not running on Windows" };
  const signalScript = String.raw`$ErrorActionPreference='Stop';
$sig='[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole(); [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId); [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId); [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr HandlerRoutine, bool Add);';
Add-Type -MemberDefinition $sig -Name ConsoleSignal -Namespace DevSpace;
[DevSpace.ConsoleSignal]::FreeConsole() | Out-Null;
$pidValue=[uint32]$env:DEVSPACE_TARGET_CONSOLE_PID;
if(-not [DevSpace.ConsoleSignal]::AttachConsole($pidValue)){ throw ('AttachConsole failed: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error()) };
[DevSpace.ConsoleSignal]::SetConsoleCtrlHandler([IntPtr]::Zero,$true) | Out-Null;
if(-not [DevSpace.ConsoleSignal]::GenerateConsoleCtrlEvent(0,0)){ throw ('GenerateConsoleCtrlEvent failed: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error()) };
Start-Sleep -Milliseconds 120;
[DevSpace.ConsoleSignal]::FreeConsole() | Out-Null;`;

  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", signalScript],
    {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, DEVSPACE_TARGET_CONSOLE_PID: String(pid) },
    }
  );
  if (result.status !== 0) {
    return { success: false, error: (result.stderr || result.stdout || `exit ${result.status}`).trim() };
  }
  return { success: true };
}
