import type { StandardToolResponse } from "../types/index.js";

export type McpContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResponse {
  content: McpContentItem[];
  isError?: boolean;
  _structured?: any;
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
    lines.push(`[VerityMCP] FAILED: ${res.action}${res.error_code ? ` [${res.error_code}]` : ""}`);
  }

  if (res.summary && res.summary !== res.text) {
    lines.push(res.summary);
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

  const execVerification = res.execution_verification || res.verification?.execution;
  if (execVerification) {
    lines.push(`[Execution Verification: ${execVerification.status} via ${execVerification.method}]`);
  }

  const stateVerification = res.state_verification || res.verification?.state;
  if (stateVerification) {
    lines.push(`[State Verification: ${stateVerification.status}${stateVerification.method ? ` via ${stateVerification.method}` : ""}]`);
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

  // Call ID & Display status
  const callId = res.call_id || `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const displayTitle = res.display_title || res.action;
  const displayStatus =
    res.display_status ||
    (res.success
      ? (res.verification?.passed || execVerification?.status === "passed") ? "verified" : "completed"
      : "failed");

  // Warnings
  const warnings: string[] = [];
  if (res.warning) warnings.push(res.warning);
  if (res.warnings) warnings.push(...res.warnings);
  if (res.stderr_present && res.success && res.stderr?.trim()) {
    warnings.push("Command emitted stderr despite exit code 0.");
  }

  // Machine-readable structured payload for autonomous agents
  const structuredPayload = {
    call_id: callId,
    display_title: displayTitle,
    display_status: warnings.length > 0 && res.success ? "warning" : displayStatus,
    success: res.success,
    action: res.action,
    summary: res.summary || res.text?.split("\n")[0] || res.action,
    ...(res.error_code ? { error_code: res.error_code } : {}),
    ...(res.data !== undefined ? { data: res.data } : {}),
    ...(res.within_workspace !== undefined ? { within_workspace: res.within_workspace } : {}),
    ...(res.workspace_root ? { workspace_root: res.workspace_root } : {}),
    ...(res.resolved_path ? { resolved_path: res.resolved_path } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(res.stderr_present !== undefined ? { stderr_present: res.stderr_present } : {}),
    execution_verification: execVerification || {
      status: res.success ? "passed" : "failed",
      method: res.verification?.method || "action_runner",
    },
    state_verification: stateVerification || {
      status: res.verification ? (res.verification.passed ? "passed" : "failed") : "not_performed",
      method: res.verification?.method,
    },
    ...(res.durationMs !== undefined ? { duration_ms: res.durationMs } : {}),
    ...(res.exitCode !== undefined && res.exitCode !== null ? { exit_code: res.exitCode } : {}),
  };

  if (warnings.length > 0) {
    lines.push(`\n[Warnings: ${warnings.join("; ")}]`);
  }

  lines.push(`\n--- STRUCTURED_PAYLOAD_JSON ---\n${JSON.stringify(structuredPayload, null, 2)}`);

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
    _structured: structuredPayload,
  };
}
