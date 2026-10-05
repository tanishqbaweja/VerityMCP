import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { workspaceManager } from "../workspace/workspace_manager.js";
import { activityStream } from "../observability/activity_stream.js";
import { calculateSha256, verifyFileExistence } from "../verification/index.js";
import type { StandardToolResponse } from "../types/index.js";

export interface DesktopScreenshotOptions {
  outputPath?: string;
  region?: { x: number; y: number; width: number; height: number };
}

export interface DesktopScreenshotData {
  requested_path: string;
  resolved_path: string;
  filePath: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  mime_type: string;
  mimeType: string;
  image_attached: boolean;
}

export interface DesktopWindowInfo {
  pid: number;
  processName: string;
  windowTitle: string;
  handle: number;
}

export async function executeDesktopScreenshot(
  options?: DesktopScreenshotOptions
): Promise<{
  toolResponse: StandardToolResponse<DesktopScreenshotData>;
  imagePayload: { data: string; mimeType: string };
}> {
  const startTime = Date.now();
  const workspaceRoot = workspaceManager.getActiveWorkspaceRoot();
  const requestedPath = options?.outputPath || "(auto-generated artifact)";
  const resolvedPath = options?.outputPath
    ? (path.isAbsolute(options.outputPath) ? path.resolve(options.outputPath) : path.resolve(workspaceRoot, options.outputPath))
    : path.join(os.tmpdir(), `verity_desktop_${randomUUID().slice(0, 8)}.png`);

  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

  activityStream.emit({
    type: "action_started",
    title: "Capturing desktop screenshot",
    purpose: "Capture desktop screen pixels to file and return visual image payload",
    tool: "screenshot_desktop",
    target: { path: resolvedPath },
  });

  const isWin = process.platform === "win32";
  let targetWidth = 1280;
  let targetHeight = 800;

  if (isWin) {
    let boundsScript = `
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$x = 0; $y = 0; $w = $screen.Width; $h = $screen.Height
`;

    if (options?.region) {
      targetWidth = options.region.width;
      targetHeight = options.region.height;
      boundsScript = `
$x = ${options.region.x}; $y = ${options.region.y}; $w = ${options.region.width}; $h = ${options.region.height}
`;
    }

    const scriptFile = path.join(os.tmpdir(), `verity_cap_${randomUUID().slice(0, 8)}.ps1`);
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${boundsScript}
try {
  $bitmap = New-Object System.Drawing.Bitmap $w, $h
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $bitmap.Save("${resolvedPath.replace(/\\/g, "\\\\")}", [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
} catch {
  Add-Type @'
  using System;
  using System.Drawing;
  using System.Drawing.Imaging;
  using System.Runtime.InteropServices;
  public class VerityScreenGrabber {
    [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr hD, int xD, int yD, int w, int h, IntPtr hS, int xS, int yS, int rop);
    public static void Capture(string p, int x, int y, int w, int h) {
      IntPtr hDesk = GetDesktopWindow();
      IntPtr hDC = GetWindowDC(hDesk);
      Bitmap bmp = new Bitmap(w, h);
      Graphics g = Graphics.FromImage(bmp);
      IntPtr hDest = g.GetHdc();
      BitBlt(hDest, 0, 0, w, h, hDC, x, y, 0x00CC0020);
      g.ReleaseHdc(hDest);
      ReleaseDC(hDesk, hDC);
      g.Dispose();
      bmp.Save(p, ImageFormat.Png);
      bmp.Dispose();
    }
  }
'@ -ReferencedAssemblies System.Drawing
  [VerityScreenGrabber]::Capture("${resolvedPath.replace(/\\/g, "\\\\")}", $x, $y, $w, $h)
}
`;

    try {
      await fs.writeFile(scriptFile, psScript, "utf-8");
      execSync(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptFile}"`, {
        stdio: "ignore",
        timeout: 10000,
      });
    } catch (err: any) {
      return {
        toolResponse: {
          success: false,
          error_code: "SCREENSHOT_WRITE_FAILED",
          action: "screenshot_desktop",
          display_title: "Capturing desktop screenshot",
          display_status: "failed",
          text: `Desktop screenshot capture failed: ${err.message}`,
          verification: { performed: true, passed: false, method: "powershell_gdi_capture", error: err.message },
          durationMs: Date.now() - startTime,
        },
        imagePayload: { data: "", mimeType: "image/png" },
      };
    } finally {
      await fs.unlink(scriptFile).catch(() => {});
    }
  } else {
    // Unix fallback
    try {
      execSync(`screencapture -x "${resolvedPath}" || import -window root "${resolvedPath}"`, {
        stdio: "ignore",
        timeout: 10000,
      });
    } catch (err: any) {
      return {
        toolResponse: {
          success: false,
          error_code: "SCREENSHOT_WRITE_FAILED",
          action: "screenshot_desktop",
          display_title: "Capturing desktop screenshot",
          display_status: "failed",
          text: `Desktop capture not supported on this platform: ${err.message}`,
          verification: { performed: true, passed: false, method: "screencapture", error: err.message },
          durationMs: Date.now() - startTime,
        },
        imagePayload: { data: "", mimeType: "image/png" },
      };
    }
  }

  // MANDATORY DISK VERIFICATION
  const verifyRes = await verifyFileExistence(resolvedPath, true);
  if (!verifyRes.passed) {
    return {
      toolResponse: {
        success: false,
        error_code: "SCREENSHOT_WRITE_FAILED",
        action: "screenshot_desktop",
        display_title: "Capturing desktop screenshot",
        display_status: "failed",
        text: `Screenshot command completed but file was not created on disk at ${resolvedPath}.`,
        verification: verifyRes,
        durationMs: Date.now() - startTime,
      },
      imagePayload: { data: "", mimeType: "image/png" },
    };
  }

  const buffer = await fs.readFile(resolvedPath);
  const sha256 = calculateSha256(buffer);
  const base64 = buffer.toString("base64");
  const withinWorkspace = resolvedPath.toLowerCase().startsWith(workspaceRoot.toLowerCase());

  activityStream.emit({
    type: "verification",
    title: "Desktop screenshot disk hash verified",
    tool: "screenshot_desktop",
    evidence: { sha256, bytes: buffer.length },
  });

  activityStream.emit({
    type: "action_completed",
    title: `Desktop screenshot attached (${buffer.length} bytes)`,
    tool: "screenshot_desktop",
    target: { path: resolvedPath },
  });

  const responseData: DesktopScreenshotData = {
    requested_path: requestedPath,
    resolved_path: resolvedPath,
    filePath: resolvedPath,
    width: targetWidth,
    height: targetHeight,
    bytes: buffer.length,
    sha256,
    mime_type: "image/png",
    mimeType: "image/png",
    image_attached: true,
  };

  return {
    toolResponse: {
      success: true,
      action: "screenshot_desktop",
      display_title: "Capturing desktop screenshot",
      display_status: "verified",
      within_workspace: withinWorkspace,
      workspace_root: workspaceRoot,
      resolved_path: resolvedPath,
      text: `Desktop screenshot captured successfully: ${resolvedPath} (${buffer.length} bytes, SHA-256: ${sha256.slice(0, 16)}...). Visual payload attached.`,
      verification: {
        performed: true,
        passed: true,
        method: "disk_file_and_buffer_validation",
        details: { filePath: resolvedPath, bytes: buffer.length, sha256 },
      },
      data: responseData,
      durationMs: Date.now() - startTime,
    },
    imagePayload: { data: base64, mimeType: "image/png" },
  };
}

export function executeListWindows(): StandardToolResponse<DesktopWindowInfo[]> {
  const startTime = Date.now();
  const isWin = process.platform === "win32";

  if (!isWin) {
    return {
      success: true,
      action: "list_windows",
      display_title: "Listing desktop windows",
      display_status: "completed",
      text: "Window enumeration is only supported on Windows host environments.",
      verification: { performed: true, passed: true, method: "platform_guard" },
      data: [],
      durationMs: Date.now() - startTime,
    };
  }

  const psScript = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WindowEnum {
    public struct WindowInfo {
        public IntPtr Handle;
        public string Title;
        public int Pid;
        public string ProcessName;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static List<WindowInfo> GetWindows() {
        var list = new List<WindowInfo>();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString();
            if (string.IsNullOrWhiteSpace(title)) return true;

            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            string procName = "";
            try {
                procName = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
            } catch {}

            list.Add(new WindowInfo {
                Handle = hWnd,
                Title = title,
                Pid = (int)pid,
                ProcessName = procName
            });
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
"@

[WindowEnum]::GetWindows() | Select-Object Handle, Pid, ProcessName, Title | ConvertTo-Json -Compress
`;

  try {
    const raw = execSync(`powershell -NoProfile -Command "${psScript.replace(/\r?\n/g, " ")}"`, {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    }).trim();

    const parsed = raw ? JSON.parse(raw) : [];
    const array = Array.isArray(parsed) ? parsed : [parsed];
    const windows: DesktopWindowInfo[] = array.map((w: any) => ({
      pid: Number(w.Pid) || 0,
      processName: String(w.ProcessName || ""),
      windowTitle: String(w.Title || ""),
      handle: Number(w.Handle) || 0,
    }));

    return {
      success: true,
      action: "list_windows",
      display_title: "Listing desktop windows",
      display_status: "verified",
      text: `Found ${windows.length} visible desktop windows:\n${windows.map((w) => `[PID ${w.pid}] "${w.windowTitle}" (${w.processName})`).join("\n")}`,
      verification: {
        performed: true,
        passed: true,
        method: "win32_enum_windows",
        details: { count: windows.length },
      },
      data: windows,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      error_code: "COMMAND_FAILED",
      action: "list_windows",
      display_title: "Listing desktop windows",
      display_status: "failed",
      text: `Failed to enumerate windows: ${err.message}`,
      verification: { performed: true, passed: false, method: "win32_enum_windows", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export function executeFocusWindow(
  titleOrPid: string | number
): StandardToolResponse<{ focused: boolean; target: string | number }> {
  const startTime = Date.now();
  if (process.platform !== "win32") {
    return {
      success: false,
      action: `focus_window "${titleOrPid}"`,
      display_title: `Focusing window "${titleOrPid}"`,
      display_status: "failed",
      text: "Window focusing only supported on Windows.",
      verification: { performed: true, passed: false, method: "platform_check" },
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const isNum = typeof titleOrPid === "number" || /^\d+$/.test(String(titleOrPid));
    const filter = isNum
      ? `$p = Get-Process -Id ${titleOrPid}`
      : `$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*${titleOrPid}*" } | Select-Object -First 1`;

    const script = `
$wscript = New-Object -ComObject Wscript.Shell
${filter}
if ($p -and $p.MainWindowHandle) {
  $wscript.AppActivate($p.Id)
  Write-Output "OK"
} else {
  Write-Output "NOT_FOUND"
}
`;
    const res = execSync(`powershell -NoProfile -Command "${script.replace(/\r?\n/g, " ")}"`, {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    }).trim();
    const focused = res === "OK";

    return {
      success: focused,
      action: `focus_window "${titleOrPid}"`,
      display_title: `Focusing window "${titleOrPid}"`,
      display_status: focused ? "verified" : "failed",
      text: focused
        ? `Focused window matching "${titleOrPid}".`
        : `Could not find active window matching "${titleOrPid}".`,
      verification: { performed: true, passed: focused, method: "app_activate" },
      data: { focused, target: titleOrPid },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      error_code: "COMMAND_FAILED",
      action: `focus_window "${titleOrPid}"`,
      display_title: `Focusing window "${titleOrPid}"`,
      display_status: "failed",
      text: `Focus failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "app_activate", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}
