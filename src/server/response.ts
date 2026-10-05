import type { StandardToolResponse } from "../types/index.js";

export type McpContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResponse {
  content: McpContentItem[];
  isError?: boolean;
}

export function formatMcpResponse<T = unknown>(
  res: StandardToolResponse<T>,
  options?: {
    image?: { data: string; mimeType: string };
    isError?: boolean;
  }
): McpToolResponse {
  const content: McpContentItem[] = [];

  // 1. Primary human / model-readable text
  const lines: string[] = [];

  if (res.success) {
    lines.push(`[VerityMCP] SUCCESS: ${res.action}`);
  } else {
    lines.push(`[VerityMCP] FAILED: ${res.action}`);
  }

  if (res.text) {
    lines.push(res.text);
  }

  // Verification status block
  if (res.verification) {
    const vStatus = res.verification.passed ? "PASSED" : "FAILED";
    lines.push(`\n[Verification: ${vStatus} via ${res.verification.method}]`);
    if (res.verification.error) {
      lines.push(`Verification Error: ${res.verification.error}`);
    }
  }

  // Optional stdout/stderr/exitCode info
  if (res.exitCode !== undefined && res.exitCode !== null) {
    lines.push(`Exit Code: ${res.exitCode} | Duration: ${res.durationMs || 0}ms`);
  }

  if (res.stdout && res.stdout.trim()) {
    lines.push(`\n--- STDOUT ---\n${res.stdout}`);
  }

  if (res.stderr && res.stderr.trim()) {
    lines.push(`\n--- STDERR ---\n${res.stderr}`);
  }

  content.push({
    type: "text",
    text: lines.join("\n"),
  });

  // 2. Image payload if supplied
  if (options?.image) {
    content.push({
      type: "image",
      data: options.image.data,
      mimeType: options.image.mimeType || "image/png",
    });
  }

  return {
    content,
    // Keep isError false for operational failures so agent can inspect stdout/stderr/exitCode
    isError: options?.isError ?? false,
  };
}
