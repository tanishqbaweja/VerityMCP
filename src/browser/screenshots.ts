import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { browserManager, type BrowserSession } from "./browser_manager.js";
import { calculateSha256, verifyFileExistence } from "../verification/index.js";
import type { StandardToolResponse } from "../types/index.js";

export interface BrowserScreenshotOptions {
  session: BrowserSession;
  outputPath?: string;
  fullPage?: boolean;
}

export interface BrowserScreenshotData {
  filePath: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  fullPage: boolean;
  mimeType: string;
}

export async function executeBrowserScreenshot(
  options: BrowserScreenshotOptions
): Promise<{
  toolResponse: StandardToolResponse<BrowserScreenshotData>;
  imagePayload: { data: string; mimeType: string };
}> {
  const startTime = Date.now();
  const { session, outputPath, fullPage = false } = options;
  const page = browserManager.getActivePage(session);

  const targetPath =
    outputPath ||
    path.join(os.tmpdir(), `devspace4_screenshot_${randomUUID().slice(0, 8)}.png`);

  let buffer: Buffer;
  try {
    buffer = await page.screenshot({ fullPage, type: "png" });
  } catch (err: any) {
    return {
      toolResponse: {
        success: false,
        action: "browser_screenshot",
        text: `Playwright screenshot capture failed: ${err.message}`,
        verification: {
          performed: true,
          passed: false,
          method: "playwright_screenshot",
          error: err.message,
        },
        durationMs: Date.now() - startTime,
      },
      imagePayload: { data: "", mimeType: "image/png" },
    };
  }

  // Save to disk
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, buffer);
  } catch (err: any) {
    return {
      toolResponse: {
        success: false,
        action: "browser_screenshot",
        text: `Failed saving screenshot to disk: ${err.message}`,
        verification: {
          performed: true,
          passed: false,
          method: "fs_writeFile",
          error: err.message,
        },
        durationMs: Date.now() - startTime,
      },
      imagePayload: { data: "", mimeType: "image/png" },
    };
  }

  // MANDATORY DISK VERIFICATION: confirm file exists and is decodable / size > 0
  const diskVerification = await verifyFileExistence(targetPath, true);
  if (!diskVerification.passed || buffer.length === 0) {
    return {
      toolResponse: {
        success: false,
        action: "browser_screenshot",
        text: `CRITICAL: Screenshot capture claimed success but file on disk is invalid or 0 bytes.`,
        verification: {
          performed: true,
          passed: false,
          method: "disk_screenshot_verification",
          error: diskVerification.error || "0 bytes buffer",
        },
        durationMs: Date.now() - startTime,
      },
      imagePayload: { data: "", mimeType: "image/png" },
    };
  }

  const sha256 = calculateSha256(buffer);
  const base64 = buffer.toString("base64");
  const viewport = page.viewportSize() || { width: 1280, height: 800 };

  const data: BrowserScreenshotData = {
    filePath: targetPath,
    bytes: buffer.length,
    sha256,
    width: viewport.width,
    height: viewport.height,
    fullPage,
    mimeType: "image/png",
  };

  const text = `Screenshot captured successfully: ${targetPath} (${buffer.length} bytes, ${viewport.width}x${viewport.height}, SHA-256: ${sha256.slice(0, 16)}...). Visual payload attached.`;

  return {
    toolResponse: {
      success: true,
      action: "browser_screenshot",
      text,
      verification: {
        performed: true,
        passed: true,
        method: "disk_file_and_buffer_validation",
        details: { filePath: targetPath, bytes: buffer.length, sha256 },
      },
      data,
      durationMs: Date.now() - startTime,
    },
    imagePayload: {
      data: base64,
      mimeType: "image/png",
    },
  };
}
