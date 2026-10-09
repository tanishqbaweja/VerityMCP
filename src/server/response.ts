import type { StandardToolResponse } from "../types/index.js";
import { activityContextStorage } from "../observability/activity_stream.js";

export type McpContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export interface McpToolResponse {
  content: McpContentItem[];
  isError?: boolean;
  _structured?: any;
}

export type McpResponseDetail = "compact" | "full";

export function formatMcpResponse<T = unknown>(
  res: StandardToolResponse<T>,
  options?: {
    image?: { data: string; mimeType: string };
    resource?: { uri: string; mimeType?: string; text?: string; blob?: string };
    isError?: boolean;
    responseDetail?: McpResponseDetail;
  }
): McpToolResponse {
  const content: McpContentItem[] = [];
  const ctx = activityContextStorage.getStore();
  const requestedDetail =
    options?.responseDetail ||
    (ctx?.args?.response_detail === "full" ? "full" : ctx?.args?.response_detail === "compact" ? "compact" : undefined);
  const environmentDetail: McpResponseDetail | undefined =
    process.env.VERITY_RESPONSE_DETAIL === "full"
      ? "full"
      : process.env.VERITY_RESPONSE_DETAIL === "compact"
        ? "compact"
        : undefined;
  const responseDetail: McpResponseDetail =
    requestedDetail || environmentDetail || (ctx ? "compact" : "full");
  const fullResponse = responseDetail === "full";

  // 1. Primary human / model-readable text
  const lines: string[] = [];

  if (res.success) {
    lines.push(`[VerityMCP] SUCCESS: ${res.action}`);
  } else {
    lines.push(`[VerityMCP] FAILED: ${res.action}${res.error_code ? ` [${res.error_code}]` : ""}`);
  }

  if (fullResponse && res.summary && res.summary !== res.text) {
    lines.push(res.summary);
  }
  if (res.text) {
    lines.push(res.text);
  } else if (res.summary) {
    lines.push(res.summary);
  }

  // Verification status block
  if (fullResponse && res.verification) {
    const vStatus = res.verification.passed ? "PASSED" : "FAILED";
    lines.push(`\n[Verification: ${vStatus} via ${res.verification.method}]`);
    if (res.verification.error) {
      lines.push(`Verification Error: ${res.verification.error}`);
    }
  }

  const execVerification = res.execution_verification || res.verification?.execution;
  if (fullResponse && execVerification) {
    lines.push(`[Execution Verification: ${execVerification.status} via ${execVerification.method}]`);
  }

  const stateVerification = res.state_verification || res.verification?.state;
  if (fullResponse && stateVerification) {
    lines.push(`[State Verification: ${stateVerification.status}${stateVerification.method ? ` via ${stateVerification.method}` : ""}]`);
  }

  if (!fullResponse && (res.verification || execVerification || stateVerification)) {
    const executionStatus = execVerification?.status || (res.success ? "passed" : "failed");
    const stateStatus =
      stateVerification?.status ||
      (res.verification ? (res.verification.passed ? "passed" : "failed") : "not_performed");
    lines.push(`[Verification: execution=${executionStatus}; state=${stateStatus}]`);
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

  // Active execution context & Call ID
  const callId = res.call_id || ctx?.callId || `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const displayTitle = res.display_title || ctx?.displayTitle || res.action;
  const purpose = res.purpose || ctx?.purpose;
  const purposeSource = res.purpose_source || ctx?.purposeSource || (purpose ? "tool_default" : undefined);
  const expectedOutcome = res.expected_outcome || ctx?.expectedOutcome;
  const target = res.target || ctx?.target;
  const displayStatus =
    res.display_status ||
    (res.success
      ? (res.verification?.passed || execVerification?.status === "passed") ? "verified" : "completed"
      : "failed");

  // Prominent user-visible operational intent badge
  if (purpose || displayTitle) {
    const purposeText = purpose ? ` | Why: ${purpose}` : "";
    lines.unshift(`[Verity Activity: ${displayTitle}${purposeText}]`);
  }

  // Deduplicated warnings
  const rawWarnings: string[] = [];
  if (res.warning) rawWarnings.push(res.warning);
  if (res.warnings) rawWarnings.push(...res.warnings);
  if (res.stderr_present && res.success && res.stderr?.trim()) {
    rawWarnings.push("Command emitted stderr despite exit code 0.");
  }
  const warnings = Array.from(new Set(rawWarnings));

  // Machine-readable structured payload for autonomous agents
  const structuredPayload = {
    call_id: callId,
    display_title: displayTitle,
    display_status: warnings.length > 0 && res.success ? "warning" : displayStatus,
    ...(purpose ? { purpose } : {}),
    ...(purposeSource ? { purpose_source: purposeSource } : {}),
    ...(expectedOutcome ? { expected_outcome: expectedOutcome } : {}),
    ...(target ? { target } : {}),
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

  if (fullResponse) {
    lines.push(`\n--- STRUCTURED_PAYLOAD_JSON ---\n${JSON.stringify(structuredPayload, null, 2)}`);
  } else {
    let compactData: unknown = undefined;
    let dataOmitted = false;
    let dataBytes = 0;
    if (res.data !== undefined) {
      try {
        const serialized = JSON.stringify(res.data);
        dataBytes = Buffer.byteLength(serialized, "utf8");
        if (dataBytes <= 2048) {
          compactData = res.data;
        } else {
          dataOmitted = true;
        }
      } catch {
        dataOmitted = true;
      }
    }

    const compactPayload = {
      call_id: callId,
      success: res.success,
      action: res.action,
      summary: structuredPayload.summary,
      ...(res.error_code ? { error_code: res.error_code } : {}),
      ...(compactData !== undefined ? { data: compactData } : {}),
      ...(dataOmitted ? { data_omitted_from_meta: true, data_bytes: dataBytes } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      execution_verification: structuredPayload.execution_verification,
      state_verification: structuredPayload.state_verification,
      ...(res.durationMs !== undefined ? { duration_ms: res.durationMs } : {}),
      ...(res.exitCode !== undefined && res.exitCode !== null ? { exit_code: res.exitCode } : {}),
    };
    lines.push(`\n--- RESPONSE_META_JSON ---\n${JSON.stringify(compactPayload)}`);
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

  // 3. Resource payload if supplied (e.g., MCP App UI)
  if (options?.resource) {
    content.push({
      type: "resource",
      resource: options.resource,
    });
  }

  return {
    content,
    // Keep isError false for operational failures so agent can inspect stdout/stderr/exitCode
    isError: options?.isError ?? false,
    _structured: structuredPayload,
  };
}
