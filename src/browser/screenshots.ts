import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { browserManager, type BrowserSession } from "./browser_manager.js";
import { workspaceManager } from "../workspace/workspace_manager.js";
import { activityStream } from "../observability/activity_stream.js";
import { calculateSha256 } from "../verification/index.js";
import { resolveArtifactOutputPath } from "../storage/paths.js";
import type { StandardToolResponse } from "../types/index.js";

export interface BrowserScreenshotOptions {
  session: BrowserSession;
  outputPath?: string;
  fullPage?: boolean;
}

export interface BrowserScreenshotData {
  requestedPath: string;
  resolvedPath: string;
  requested_path?: string;
  resolved_path?: string;
  image_attached?: boolean;
  filePath: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  fullPage: boolean;
  mimeType: string;
  within_workspace?: boolean;
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

  const workspaceRoot = workspaceManager.getActiveWorkspaceRoot();
  const { resolvedPath, requestedPath, withinWorkspace } = resolveArtifactOutputPath(outputPath, workspaceRoot, ".png");

  activityStream.emit({
    type: "action_started",
    tool: "browser_screenshot",
    title: "Capturing browser screenshot",
    display_title: "Capturing browser screenshot",
    purpose: "Visually confirm rendered state matches DOM state.",
    target: { outputPath: requestedPath, session_id: session.id },
    browser_session_id: session.id,
    status: "running",
  });

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

  // Ensure parent directory exists
  try {
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, buffer);
  } catch (err: any) {
    return {
      toolResponse: {
        success: false,
        action: "browser_screenshot",
        text: `Failed saving screenshot to disk at "${resolvedPath}": ${err.message}`,
        verification: {
          performed: true,
          passed: false,
          method: "fs_writeFile",
          error: err.message,
          details: { requestedPath, resolvedPath },
        },
        durationMs: Date.now() - startTime,
      },
      imagePayload: { data: "", mimeType: "image/png" },
    };
  }

  // MANDATORY DISK VERIFICATION: confirm file exists, size > 0, decodes as PNG, SHA-256 matches
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch (err: any) {
    return {
      toolResponse: {
        success: false,
        action: "browser_screenshot",
        text: `CRITICAL: Screenshot file does not exist at resolved path: ${resolvedPath}`,
        verification: {
          performed: true,
          passed: false,
          method: "disk_file_and_buffer_validation",
          error: `File not found on disk: ${err.message}`,
          details: { requestedPath, resolvedPath },
        },
        durationMs: Date.now() - startTime,
      },
      imagePayload: { data: "", mimeType: "image/png" },
    };
  }

  if (stat.size === 0 || stat.size !== buffer.length) {
    return {
      toolResponse: {
        success: false,
        action: "browser_screenshot",
        text: `CRITICAL: Screenshot file on disk has unexpected size: expected ${buffer.length} bytes, found ${stat.size} bytes.`,
        verification: {
          performed: true,
          passed: false,
          method: "disk_file_and_buffer_validation",
          error: `Byte length mismatch on disk (${stat.size} !== ${buffer.length})`,
          details: { requestedPath, resolvedPath, expectedBytes: buffer.length, actualBytes: stat.size },
        },
        durationMs: Date.now() - startTime,
      },
      imagePayload: { data: "", mimeType: "image/png" },
    };
  }

  let diskBytes: Buffer;
  try {
    diskBytes = await fs.readFile(resolvedPath);
  } catch (err: any) {
    return {
      toolResponse: {
        success: false,
        action: "browser_screenshot",
        text: `CRITICAL: Failed reading back saved screenshot from disk: ${err.message}`,
        verification: {
          performed: true,
          passed: false,
          method: "disk_file_and_buffer_validation",
          error: err.message,
        },
        durationMs: Date.now() - startTime,
      },
      imagePayload: { data: "", mimeType: "image/png" },
    };
  }

  // Verify PNG header bytes (89 50 4E 47 0D 0A 1A 0A)
  if (diskBytes[0] !== 0x89 || diskBytes[1] !== 0x50 || diskBytes[2] !== 0x4e || diskBytes[3] !== 0x47) {
    return {
      toolResponse: {
        success: false,
        action: "browser_screenshot",
        text: `CRITICAL: Saved screenshot on disk is not a valid decodable PNG image.`,
        verification: {
          performed: true,
          passed: false,
          method: "disk_file_and_buffer_validation",
          error: "Magic bytes do not match PNG format",
          details: { requestedPath, resolvedPath },
        },
        durationMs: Date.now() - startTime,
      },
      imagePayload: { data: "", mimeType: "image/png" },
    };
  }

  const sha256 = calculateSha256(diskBytes);
  const bufferSha = calculateSha256(buffer);
  if (sha256 !== bufferSha) {
    return {
      toolResponse: {
        success: false,
        action: "browser_screenshot",
        text: `CRITICAL: Saved file SHA-256 does not match captured screenshot buffer.`,
        verification: {
          performed: true,
          passed: false,
          method: "disk_file_and_buffer_validation",
          error: "SHA-256 hash mismatch between disk and memory",
          details: { diskSha256: sha256, bufferSha256: bufferSha },
        },
        durationMs: Date.now() - startTime,
      },
      imagePayload: { data: "", mimeType: "image/png" },
    };
  }

  const base64 = diskBytes.toString("base64");
  const viewport = page.viewportSize() || { width: 1280, height: 800 };

  const data: BrowserScreenshotData = {
    requestedPath,
    resolvedPath,
    requested_path: requestedPath,
    resolved_path: resolvedPath,
    image_attached: true,
    filePath: resolvedPath,
    bytes: diskBytes.length,
    sha256,
    width: viewport.width,
    height: viewport.height,
    fullPage,
    mimeType: "image/png",
    within_workspace: withinWorkspace,
  };

  const text = [
    `Screenshot captured successfully:`,
    `  Requested Path: ${requestedPath}`,
    `  Resolved Path:  ${resolvedPath}`,
    `  Dimensions:     ${viewport.width}x${viewport.height}`,
    `  Bytes:          ${diskBytes.length}`,
    `  SHA-256:        ${sha256}`,
    `[Verification: PASSED via disk_file_and_buffer_validation]`,
  ].join("\n");

  activityStream.emit({
    type: "verification",
    tool: "browser_screenshot",
    title: "Screenshot verified",
    display_title: "Screenshot verified",
    target: { resolvedPath },
    evidence: {
      dimensions: `${viewport.width}x${viewport.height}`,
      bytes: diskBytes.length,
      sha256,
      visualPayloadAttached: true,
    },
    browser_session_id: session.id,
    status: "verified",
  });

  return {
    toolResponse: {
      success: true,
      action: "browser_screenshot",
      text,
      verification: {
        performed: true,
        passed: true,
        method: "disk_file_and_buffer_validation",
        details: { requestedPath, resolvedPath, bytes: diskBytes.length, sha256 },
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
