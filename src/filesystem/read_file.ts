import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../security/roots.js";
import { calculateSha256 } from "../verification/index.js";
import type { StandardToolResponse } from "../types/index.js";

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
};

export interface ReadFileOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  withLineNumbers?: boolean;
}

export interface ReadFileData {
  filePath: string;
  isImage: boolean;
  mimeType?: string;
  base64?: string;
  sizeBytes: number;
  sha256: string;
  totalLines?: number;
  linesRead?: number;
  lineStart?: number;
  lineEnd?: number;
  content?: string;
}

export async function executeReadFile(
  options: ReadFileOptions
): Promise<{
  toolResponse: StandardToolResponse<ReadFileData>;
  imagePayload?: { data: string; mimeType: string };
}> {
  const startTime = Date.now();
  const { workspaceRoot, allowedRoots = [], filePath, lineStart, lineEnd, withLineNumbers = true } = options;

  let resolvedPath: string;
  try {
    resolvedPath = resolveWorkspacePath(workspaceRoot, filePath, allowedRoots);
  } catch (err: any) {
    return {
      toolResponse: {
        success: false,
        action: `read_file "${filePath}"`,
        text: `Path validation failed: ${err.message}`,
        verification: {
          performed: true,
          passed: false,
          method: "path_containment_check",
          error: err.message,
        },
        durationMs: Date.now() - startTime,
      },
    };
  }

  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch (err: any) {
    return {
      toolResponse: {
        success: false,
        action: `read_file "${filePath}"`,
        text: `File not found: "${filePath}" (${err.message})`,
        verification: {
          performed: true,
          passed: false,
          method: "fs_stat",
          error: err.message,
        },
        durationMs: Date.now() - startTime,
      },
    };
  }

  if (stat.isDirectory()) {
    return {
      toolResponse: {
        success: false,
        action: `read_file "${filePath}"`,
        text: `Target "${filePath}" is a directory, not a file. Use list_directory instead.`,
        verification: {
          performed: true,
          passed: false,
          method: "fs_stat_isFile",
          error: "Path is a directory",
        },
        durationMs: Date.now() - startTime,
      },
    };
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const isImage = ext in IMAGE_EXTENSIONS;

  if (isImage) {
    const buffer = await fs.readFile(resolvedPath);
    const mimeType = IMAGE_EXTENSIONS[ext];
    const base64 = buffer.toString("base64");
    const sha256 = calculateSha256(buffer);

    const data: ReadFileData = {
      filePath,
      isImage: true,
      mimeType,
      base64,
      sizeBytes: buffer.length,
      sha256,
    };

    return {
      toolResponse: {
        success: true,
        action: `read_file (image) "${filePath}"`,
        text: `Image file loaded: ${filePath} (${mimeType}, ${buffer.length} bytes, SHA-256: ${sha256.slice(0, 16)}...)`,
        verification: {
          performed: true,
          passed: true,
          method: "fs_read_binary",
          details: { sizeBytes: buffer.length, mimeType, sha256 },
        },
        data,
        durationMs: Date.now() - startTime,
      },
      imagePayload: {
        data: base64,
        mimeType,
      },
    };
  }

  // Text file read
  try {
    const rawBuffer = await fs.readFile(resolvedPath);
    const sha256 = calculateSha256(rawBuffer);
    const content = rawBuffer.toString("utf-8");

    // Check if file is binary (contains null bytes)
    if (content.includes("\0")) {
      return {
        toolResponse: {
          success: true,
          action: `read_file (binary) "${filePath}"`,
          text: `[Binary file: "${filePath}", size: ${rawBuffer.length} bytes, SHA-256: ${sha256.slice(0, 16)}...]`,
          verification: {
            performed: true,
            passed: true,
            method: "fs_read_binary_probe",
            details: { sizeBytes: rawBuffer.length, isBinary: true },
          },
          data: {
            filePath,
            isImage: false,
            sizeBytes: rawBuffer.length,
            sha256,
          },
          durationMs: Date.now() - startTime,
        },
      };
    }

    const allLines = content.split(/\r?\n/);
    const totalLines = allLines.length;

    const start = Math.max(1, lineStart ?? 1);
    const end = Math.min(totalLines, lineEnd ?? totalLines);

    if (start > totalLines && totalLines > 0) {
      return {
        toolResponse: {
          success: false,
          action: `read_file "${filePath}"`,
          text: `lineStart (${start}) exceeds total line count (${totalLines}) in "${filePath}".`,
          verification: {
            performed: true,
            passed: false,
            method: "line_boundary_check",
            error: "lineStart out of bounds",
          },
          durationMs: Date.now() - startTime,
        },
      };
    }

    const slicedLines = allLines.slice(start - 1, end);
    const formattedLines = withLineNumbers
      ? slicedLines.map((line, idx) => {
          const lineNum = (start + idx).toString().padStart(4, " ");
          return `${lineNum} | ${line}`;
        })
      : slicedLines;

    const textOutput = formattedLines.join("\n");

    const data: ReadFileData = {
      filePath,
      isImage: false,
      sizeBytes: rawBuffer.length,
      sha256,
      totalLines,
      linesRead: slicedLines.length,
      lineStart: start,
      lineEnd: end,
      content: slicedLines.join("\n"),
    };

    const header = `File: ${filePath} (${totalLines} lines, ${rawBuffer.length} bytes | showing lines ${start}-${end})\n---`;
    const fullText = `${header}\n${textOutput}`;

    return {
      toolResponse: {
        success: true,
        action: `read_file "${filePath}" [${start}-${end}]`,
        text: fullText,
        verification: {
          performed: true,
          passed: true,
          method: "readback_sha256",
          details: {
            sizeBytes: rawBuffer.length,
            sha256,
            totalLines,
            linesRead: slicedLines.length,
          },
        },
        data,
        durationMs: Date.now() - startTime,
      },
    };
  } catch (err: any) {
    return {
      toolResponse: {
        success: false,
        action: `read_file "${filePath}"`,
        text: `Failed to read file "${filePath}": ${err.message}`,
        verification: {
          performed: true,
          passed: false,
          method: "fs_read_error",
          error: err.message,
        },
        durationMs: Date.now() - startTime,
      },
    };
  }
}
