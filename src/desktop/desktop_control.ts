import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { calculateSha256, verifyFileExistence } from "../verification/index.js";
import type { StandardToolResponse } from "../types/index.js";

export interface DesktopScreenshotOptions {
  outputPath?: string;
  region?: { x: number; y: number; width: number; height: number };
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
  toolResponse: StandardToolResponse<{ filePath: string; bytes: number; sha256: string }>;
  imagePayload: { data: string; mimeType: string };
}> {
  const startTime = Date.now();
  const targetPath =
    options?.outputPath ||
    path.join(os.tmpdir(), `verity_desktop_${randomUUID().slice(0, 8)}.png`);

  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  const isWin = process.platform === "win32";

  if (isWin) {
    let boundsScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$x = 0; $y = 0; $w = $screen.Width; $h = $screen.Height
`;

    if (options?.region) {
      boundsScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$x = ${options.region.x}; $y = ${options.region.y}; $w = ${options.region.width}; $h = ${options.region.height}
`;
    }

    const psScript = `
${boundsScript}
$bitmap = New-Object System.Drawing.Bitmap $w, $h
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
$bitmap.Save("${targetPath.replace(/\\/g, "\\\\")}", [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`;

    try {
      execSync(`powershell -NoProfile -Command "${psScript.replace(/\r?\n/g, " ")}"`, {
        stdio: "ignore",
        timeout: 10000,
      });
    } catch (err: any) {
      return {
        toolResponse: {
          success: false,
          action: "screenshot_desktop",
          text: `Desktop screenshot capture failed: ${err.message}`,
          verification: { performed: true, passed: false, method: "powershell_gdi_capture", error: err.message },
          durationMs: Date.now() - startTime,
        },
        imagePayload: { data: "", mimeType: "image/png" },
      };
    }
  } else {
    // Unix fallback
    try {
      execSync(`screencapture -x "${targetPath}" || import -window root "${targetPath}"`, {
        stdio: "ignore",
        timeout: 10000,
      });
    } catch (err: any) {
      return {
        toolResponse: {
          success: false,
          action: "screenshot_desktop",
          text: `Desktop capture not supported on this platform: ${err.message}`,
          verification: { performed: true, passed: false, method: "screencapture", error: err.message },
          durationMs: Date.now() - startTime,
        },
        imagePayload: { data: "", mimeType: "image/png" },
      };
    }
  }

  // MANDATORY VERIFICATION
  const verifyRes = await verifyFileExistence(targetPath, true);
  if (!verifyRes.passed) {
    return {
      toolResponse: {
        success: false,
        action: "screenshot_desktop",
        text: `Screenshot command completed but file was not created on disk.`,
        verification: verifyRes,
        durationMs: Date.now() - startTime,
      },
      imagePayload: { data: "", mimeType: "image/png" },
    };
  }

  const buffer = await fs.readFile(targetPath);
  const sha256 = calculateSha256(buffer);
  const base64 = buffer.toString("base64");

  return {
    toolResponse: {
      success: true,
      action: "screenshot_desktop",
      text: `Desktop screenshot captured successfully: ${targetPath} (${buffer.length} bytes, SHA-256: ${sha256.slice(0, 16)}...). Visual payload attached.`,
      verification: {
        performed: true,
        passed: true,
        method: "disk_file_and_buffer_validation",
        details: { filePath: targetPath, bytes: buffer.length, sha256 },
      },
      data: { filePath: targetPath, bytes: buffer.length, sha256 },
      durationMs: Date.now() - startTime,
    },
    imagePayload: { data: base64, mimeType: "image/png" },
  };
}

export function executeListWindows(): StandardToolResponse<DesktopWindowInfo[]> {
  const startTime = Date.now();
  if (process.platform !== "win32") {
    return {
      success: true,
      action: "list_windows",
      text: "Window enumeration currently supported on Windows hosts.",
      verification: { performed: true, passed: true, method: "platform_guard" },
      data: [],
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const ps = `Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle | ConvertTo-Json`;
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: "utf-8", timeout: 8000 });
    const parsed = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : [parsed];

    const windows: DesktopWindowInfo[] = list
      .filter((p: any) => p && p.MainWindowTitle)
      .map((p: any) => ({
        pid: p.Id,
        processName: p.ProcessName,
        windowTitle: p.MainWindowTitle,
        handle: p.MainWindowHandle,
      }));

    const lines = windows.map((w) => `[PID ${w.pid}] "${w.windowTitle}" (${w.processName})`);
    const text = windows.length > 0 ? `Active Windows (${windows.length}):\n${lines.join("\n")}` : "No titled windows detected.";

    return {
      success: true,
      action: "list_windows",
      text,
      verification: { performed: true, passed: true, method: "powershell_get_process", details: { count: windows.length } },
      data: windows,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: "list_windows",
      text: `Failed to list desktop windows: ${err.message}`,
      verification: { performed: true, passed: false, method: "powershell_query", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export function executeFocusWindow(titleOrPid: string | number): StandardToolResponse<{ focused: boolean; target: string | number }> {
  const startTime = Date.now();
  if (process.platform !== "win32") {
    return {
      success: false,
      action: `focus_window "${titleOrPid}"`,
      text: "Window focusing only supported on Windows.",
      verification: { performed: true, passed: false, method: "platform_check" },
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const isNum = typeof titleOrPid === "number" || /^\d+$/.test(String(titleOrPid));
    const filter = isNum ? `$p = Get-Process -Id ${titleOrPid}` : `$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*${titleOrPid}*" } | Select-Object -First 1`;

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
    const res = execSync(`powershell -NoProfile -Command "${script.replace(/\r?\n/g, " ")}"`, { encoding: "utf-8" }).trim();
    const focused = res === "OK";

    return {
      success: focused,
      action: `focus_window "${titleOrPid}"`,
      text: focused ? `Focused window matching "${titleOrPid}".` : `Could not find active window matching "${titleOrPid}".`,
      verification: { performed: true, passed: focused, method: "app_activate" },
      data: { focused, target: titleOrPid },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: `focus_window "${titleOrPid}"`,
      text: `Focus failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "app_activate", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}
