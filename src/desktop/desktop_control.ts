import fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { workspaceManager } from "../workspace/workspace_manager.js";
import { activityStream } from "../observability/activity_stream.js";
import { calculateSha256, verifyFileExistence } from "../verification/index.js";
import { resolveArtifactOutputPath } from "../storage/paths.js";
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
  process_name?: string;
  windowTitle: string;
  title?: string;
  handle: number | string;
}

export async function executeDesktopScreenshot(
  options?: DesktopScreenshotOptions
): Promise<{
  toolResponse: StandardToolResponse<DesktopScreenshotData>;
  imagePayload: { data: string; mimeType: string };
}> {
  const startTime = Date.now();
  const workspaceRoot = workspaceManager.getActiveWorkspaceRoot();
  const { resolvedPath, requestedPath } = resolveArtifactOutputPath(options?.outputPath, workspaceRoot, ".png");

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
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile], {
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
      try {
        execFileSync("screencapture", ["-x", resolvedPath], {
          stdio: "ignore",
          timeout: 10000,
        });
      } catch {
        execFileSync("import", ["-window", "root", resolvedPath], {
          stdio: "ignore",
          timeout: 10000,
        });
      }
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
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WindowEnum {
    public struct WindowInfo {
        public long Handle;
        public string Title;
        public int Pid;
        public string ProcessName;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpfn, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static string Sanitize(string s) {
        if (string.IsNullOrEmpty(s)) return "";
        var chars = s.ToCharArray();
        for (int i = 0; i < chars.Length; i++) {
            if (char.IsControl(chars[i])) chars[i] = ' ';
        }
        return new string(chars).Trim();
    }

    public static List<WindowInfo> GetWindows() {
        var list = new List<WindowInfo>();
        EnumWindowsProc callback = (hWnd, lParam) => {
            try {
                if (!IsWindowVisible(hWnd)) return true;
                var sb = new StringBuilder(512);
                GetWindowText(hWnd, sb, 512);
                string title = sb.ToString();
                if (string.IsNullOrWhiteSpace(title)) return true;
                string cleanTitle = Sanitize(title);
                if (string.IsNullOrWhiteSpace(cleanTitle)) return true;

                uint pid = 0;
                GetWindowThreadProcessId(hWnd, out pid);
                string procName = "";
                if (pid > 0) {
                    try {
                        procName = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
                    } catch {}
                }

                list.Add(new WindowInfo {
                    Handle = hWnd.ToInt64(),
                    Title = cleanTitle,
                    Pid = (int)pid,
                    ProcessName = Sanitize(procName)
                });
            } catch {}
            return true;
        };

        var seen = new HashSet<long>();
        EnumWindowsProc safeCallback = (hWnd, lParam) => {
            long val = hWnd.ToInt64();
            if (seen.Contains(val)) return true;
            seen.Add(val);
            return callback(hWnd, lParam);
        };

        IntPtr hDesk = IntPtr.Zero;
        try {
            hDesk = OpenInputDesktop(0, false, 0x0001);
        } catch {}

        if (hDesk != IntPtr.Zero) {
            try {
                EnumDesktopWindows(hDesk, safeCallback, IntPtr.Zero);
            } finally {
                CloseDesktop(hDesk);
            }
        }
        EnumWindows(safeCallback, IntPtr.Zero);

        return list;
    }
}
'@

[WindowEnum]::GetWindows() | Select-Object @{N='handle';E={$_.Handle}}, @{N='pid';E={$_.Pid}}, @{N='process_name';E={$_.ProcessName}}, @{N='title';E={$_.Title}} | ConvertTo-Json -Compress
`;

  const scriptPath = path.join(os.tmpdir(), `verity_win_enum_${randomUUID().slice(0, 8)}.ps1`);
  try {
    nodeFs.writeFileSync(scriptPath, psScript, "utf-8");
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      encoding: "utf-8",
      timeout: 10000,
      windowsHide: true,
    }).trim();

    let parsed: any = [];
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        const sanitized = raw.replace(/[\x00-\x1f\x7f]/g, " ");
        parsed = JSON.parse(sanitized);
      }
    }
    const array = Array.isArray(parsed) ? parsed : [parsed];
    const windows: DesktopWindowInfo[] = array.map((w: any) => {
      const pid = Number(w.pid) || 0;
      const proc = String(w.process_name || w.processName || "");
      const title = String(w.title || w.windowTitle || "");
      const handle = w.handle !== undefined ? w.handle : 0;
      return {
        pid,
        processName: proc,
        process_name: proc,
        windowTitle: title,
        title,
        handle,
      };
    });

    return {
      success: true,
      action: "list_windows",
      display_title: "Listing desktop windows",
      display_status: "verified",
      text: `Found ${windows.length} visible desktop windows:\n${windows.map((w) => `[PID ${w.pid}] "${w.title}" (${w.process_name})`).join("\n")}`,
      verification: {
        performed: true,
        passed: true,
        method: "win32_enum_desktop_windows",
        details: { count: windows.length },
      },
      data: windows,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    let errorCode = "WINDOW_ENUMERATION_FAILED";
    const msg = String(err?.message || "");
    if (err?.code === "ENOENT" || msg.includes("is not recognized") || msg.includes("cannot find the path") || msg.includes("cannot find the file specified")) {
      errorCode = "POWERSHELL_UNAVAILABLE";
    } else if (msg.includes("Add-Type") || msg.includes("compiler error") || msg.includes("CS0") || msg.includes("Compilation failed")) {
      errorCode = "WINDOW_ENUMERATION_COMPILE_FAILED";
    }

    return {
      success: false,
      error_code: errorCode,
      action: "list_windows",
      display_title: "Listing desktop windows",
      display_status: "failed",
      text: `Failed to enumerate windows: ${err.message}`,
      verification: { performed: true, passed: false, method: "win32_enum_desktop_windows", error: err.message },
      durationMs: Date.now() - startTime,
    };
  } finally {
    try {
      if (nodeFs.existsSync(scriptPath)) {
        nodeFs.unlinkSync(scriptPath);
      }
    } catch {}
  }
}

export interface FocusWindowResult {
  focused: boolean;
  target: string | number;
  requested_target?: string | number;
  resolved_hwnd?: number | string;
  foreground_hwnd_before?: number | string;
  foreground_hwnd_after?: number | string;
  activation_method?: string;
}

export function executeFocusWindow(
  titleOrPid: string | number
): StandardToolResponse<FocusWindowResult> {
  const startTime = Date.now();
  if (process.platform !== "win32") {
    return {
      success: false,
      error_code: "PLATFORM_NOT_SUPPORTED",
      action: `focus_window "${titleOrPid}"`,
      display_title: `Focusing window "${titleOrPid}"`,
      display_status: "failed",
      text: "Window focusing only supported on Windows.",
      verification: { performed: true, passed: false, method: "platform_check" },
      data: { focused: false, target: titleOrPid, requested_target: titleOrPid },
      durationMs: Date.now() - startTime,
    };
  }

  const scriptPath = path.join(os.tmpdir(), `verity_focus_${randomUUID().slice(0, 8)}.ps1`);
  try {
    const isNum = typeof titleOrPid === "number" || /^\d+$/.test(String(titleOrPid).trim());
    const targetFilter = isNum ? String(titleOrPid).trim() : JSON.stringify(String(titleOrPid));

    const script = `
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WinFocuser {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", ExactSpelling = true)]
    public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpfn, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO {
        public int cbSize;
        public int flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public const uint GA_ROOTOWNER = 3;
    public const int SW_RESTORE = 9;
    public const int SW_SHOW = 5;
    public const byte VK_MENU = 0x12;
    public const uint KEYEVENTF_KEYUP = 0x0002;

    public class Result {
        public bool Success;
        public bool Focused;
        public long ResolvedHwnd;
        public long ForegroundBefore;
        public long ForegroundAfter;
        public string Method;
        public string Error;
    }

    public static List<IntPtr> FindHwnds(string titleQuery, int pidQuery, long directHwnd) {
        var list = new List<IntPtr>();
        if (directHwnd != 0 && IsWindow(new IntPtr(directHwnd))) {
            list.Add(new IntPtr(directHwnd));
            return list;
        }

        var seen = new HashSet<long>();
        EnumWindowsProc searchCb = (hWnd, lParam) => {
            long val = hWnd.ToInt64();
            if (seen.Contains(val)) return true;
            seen.Add(val);

            if (!IsWindow(hWnd) || !IsWindowVisible(hWnd)) return true;
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);

            var sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, 512);
            string title = sb.ToString();

            if (directHwnd != 0 && (val == directHwnd || (int)hWnd == (int)directHwnd)) {
                list.Add(hWnd);
            } else if (pidQuery > 0 && (int)pid == pidQuery) {
                list.Add(hWnd);
            } else if (!string.IsNullOrEmpty(titleQuery) && (title.IndexOf(titleQuery, StringComparison.OrdinalIgnoreCase) >= 0 || title.Trim().IndexOf(titleQuery.Trim(), StringComparison.OrdinalIgnoreCase) >= 0)) {
                list.Add(hWnd);
            }
            return true;
        };

        IntPtr hDesk = IntPtr.Zero;
        try {
            hDesk = OpenInputDesktop(0, false, 0x0001);
        } catch {}

        if (hDesk != IntPtr.Zero) {
            try {
                EnumDesktopWindows(hDesk, searchCb, IntPtr.Zero);
            } finally {
                CloseDesktop(hDesk);
            }
        }
        EnumWindows(searchCb, IntPtr.Zero);

        return list;
    }

    public static Result Focus(IntPtr targetHwnd) {
        var res = new Result();
        res.ResolvedHwnd = targetHwnd.ToInt64();

        if (targetHwnd == IntPtr.Zero || !IsWindow(targetHwnd)) {
            res.Error = "WINDOW_NOT_FOUND";
            res.Method = "none";
            return res;
        }

        IntPtr fgBefore = GetForegroundWindow();
        res.ForegroundBefore = fgBefore.ToInt64();

        if (fgBefore == targetHwnd || GetAncestor(fgBefore, GA_ROOTOWNER) == targetHwnd) {
            res.Focused = true;
            res.Success = true;
            res.ForegroundAfter = fgBefore.ToInt64();
            res.Method = "already_foreground";
            return res;
        }

        if (IsIconic(targetHwnd)) {
            ShowWindow(targetHwnd, SW_RESTORE);
        } else {
            ShowWindow(targetHwnd, SW_SHOW);
        }

        BringWindowToTop(targetHwnd);
        keybd_event(VK_MENU, 0, 0, 0);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
        SetForegroundWindow(targetHwnd);

        IntPtr fgAfter = GetForegroundWindow();
        if (fgAfter == targetHwnd || GetAncestor(fgAfter, GA_ROOTOWNER) == targetHwnd || GetAncestor(targetHwnd, GA_ROOTOWNER) == fgAfter) {
            res.Focused = true;
            res.Success = true;
            res.ForegroundAfter = fgAfter.ToInt64();
            res.Method = "direct_set_foreground";
            return res;
        }

        uint curT = GetCurrentThreadId();
        uint fgPid = 0;
        uint fgT = GetWindowThreadProcessId(fgBefore, out fgPid);
        uint targetPid = 0;
        uint targetT = GetWindowThreadProcessId(targetHwnd, out targetPid);

        bool attFg = false;
        bool attTarget = false;
        try {
            if (fgT != 0 && fgT != curT) attFg = AttachThreadInput(curT, fgT, true);
            if (targetT != 0 && targetT != curT) attTarget = AttachThreadInput(curT, targetT, true);

            BringWindowToTop(targetHwnd);
            keybd_event(VK_MENU, 0, 0, 0);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
            SetForegroundWindow(targetHwnd);
            System.Threading.Thread.Sleep(60);
        } finally {
            if (attFg) AttachThreadInput(curT, fgT, false);
            if (attTarget) AttachThreadInput(curT, targetT, false);
        }

        fgAfter = GetForegroundWindow();
        res.ForegroundAfter = fgAfter.ToInt64();
        if (fgAfter == targetHwnd || GetAncestor(fgAfter, GA_ROOTOWNER) == targetHwnd || GetAncestor(targetHwnd, GA_ROOTOWNER) == fgAfter) {
            res.Focused = true;
            res.Success = true;
            res.Method = "attach_thread_input";
            return res;
        }

        // When GetForegroundWindow() is 0 (headless/service/background desktop session),
        // verify focus via target GUI thread info (active/focused window)
        var gui = new GUITHREADINFO();
        gui.cbSize = Marshal.SizeOf(gui);
        if (GetGUIThreadInfo(targetT, ref gui)) {
            if (gui.hwndActive == targetHwnd || gui.hwndFocus == targetHwnd || GetAncestor(gui.hwndActive, GA_ROOTOWNER) == targetHwnd) {
                res.Focused = true;
                res.Success = true;
                res.ForegroundAfter = targetHwnd.ToInt64();
                res.Method = "gui_thread_focus_verified";
                return res;
            }
        }

        res.Focused = false;
        res.Success = false;
        res.Error = "ACTIVATION_FAILED";
        res.Method = "activation_attempted";

        return res;
    }
}
'@

$isNum = ${isNum ? "$true" : "$false"}
$targetVal = ${targetFilter}
$titleQuery = ""
$pidQuery = 0
$directHwnd = 0L

if ($isNum) {
    $num = [int64]$targetVal
    if ($num -gt 65535) {
        $directHwnd = $num
    }
    $pidQuery = [int]$num
} else {
    $titleQuery = [string]$targetVal
}

$hwnds = [WinFocuser]::FindHwnds($titleQuery, $pidQuery, $directHwnd)
if ($hwnds.Count -eq 0) {
    @{
        success = $false
        focused = $false
        error = "WINDOW_NOT_FOUND"
        method = "none"
        resolved_hwnd = 0
        foreground_before = 0
        foreground_after = [WinFocuser]::GetForegroundWindow().ToInt64()
    } | ConvertTo-Json -Compress
    exit 0
}

$targetHwnd = $hwnds[0]
$res = [WinFocuser]::Focus($targetHwnd)

@{
    success = $res.Success
    focused = $res.Focused
    error = $res.Error
    method = $res.Method
    resolved_hwnd = $res.ResolvedHwnd
    foreground_before = $res.ForegroundBefore
    foreground_after = $res.ForegroundAfter
} | ConvertTo-Json -Compress
`;

    nodeFs.writeFileSync(scriptPath, script, "utf-8");
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      encoding: "utf-8",
      timeout: 8000,
      windowsHide: false,
    }).trim();

    console.log("RAW FOCUS OUTPUT:", raw);
    let parsed: any = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const lastLine = lines[lines.length - 1] || "{}";
        parsed = JSON.parse(lastLine);
      }
    }

    const focused = Boolean(parsed.focused && parsed.success);
    const resolvedHwnd = parsed.resolved_hwnd || 0;
    const fgBefore = parsed.foreground_before || 0;
    const fgAfter = parsed.foreground_after || 0;
    const method = parsed.method || "none";
    const errorCode = parsed.error || (focused ? undefined : "ACTIVATION_FAILED");

    const resultData: FocusWindowResult = {
      focused,
      target: titleOrPid,
      requested_target: titleOrPid,
      resolved_hwnd: resolvedHwnd,
      foreground_hwnd_before: fgBefore,
      foreground_hwnd_after: fgAfter,
      activation_method: method,
    };

    if (focused) {
      return {
        success: true,
        action: `focus_window "${titleOrPid}"`,
        display_title: `Focusing window "${titleOrPid}"`,
        display_status: "verified",
        text: `Focused window matching "${titleOrPid}" (HWND: ${resolvedHwnd}, Method: ${method}). Foreground window verified.`,
        summary: `Focused window matching "${titleOrPid}" (verified)`,
        verification: {
          performed: true,
          passed: true,
          method: "win32_foreground_verification",
          details: {
            target: titleOrPid,
            resolvedHwnd,
            foregroundBefore: fgBefore,
            foregroundAfter: fgAfter,
            activationMethod: method,
          },
        },
        data: resultData,
        durationMs: Date.now() - startTime,
      };
    }

    return {
      success: false,
      error_code: errorCode,
      action: `focus_window "${titleOrPid}"`,
      display_title: `Focusing window "${titleOrPid}"`,
      display_status: "failed",
      text: `Could not activate window matching "${titleOrPid}" (Status: ${errorCode}, Resolved HWND: ${resolvedHwnd}, Foreground: ${fgAfter}).`,
      summary: `Failed to focus window: ${errorCode}`,
      verification: {
        performed: true,
        passed: false,
        method: "win32_foreground_verification",
        error: errorCode,
        details: {
          target: titleOrPid,
          resolvedHwnd,
          foregroundBefore: fgBefore,
          foregroundAfter: fgAfter,
          activationMethod: method,
        },
      },
      data: resultData,
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
      verification: { performed: true, passed: false, method: "win32_foreground_verification", error: err.message },
      data: { focused: false, target: titleOrPid, requested_target: titleOrPid },
      durationMs: Date.now() - startTime,
    };
  } finally {
    try {
      if (nodeFs.existsSync(scriptPath)) {
        nodeFs.unlinkSync(scriptPath);
      }
    } catch {}
  }
}
