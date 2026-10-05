import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { RunMetadata } from "./types.js";

/**
 * Redact sensitive tokens, authorization headers, passwords, and API keys.
 */
export function sanitizeSecrets(text: string): string {
  if (!text || typeof text !== "string") return text;

  let sanitized = text;

  // OpenAI, Anthropic, GitHub, Google tokens
  sanitized = sanitized.replace(/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED_API_KEY]");
  sanitized = sanitized.replace(/ghp_[a-zA-Z0-9]{30,}/g, "[REDACTED_GITHUB_TOKEN]");
  sanitized = sanitized.replace(/gho_[a-zA-Z0-9]{30,}/g, "[REDACTED_GITHUB_TOKEN]");
  sanitized = sanitized.replace(/AIza[0-9A-Za-z-_]{35}/g, "[REDACTED_GOOGLE_API_KEY]");

  // Bearer tokens & Authorization headers
  sanitized = sanitized.replace(/Bearer\s+[a-zA-Z0-9_\-\.]{15,}/gi, "Bearer [REDACTED_TOKEN]");
  sanitized = sanitized.replace(/(Authorization:\s*)[^\r\n]+/gi, "$1[REDACTED]");
  sanitized = sanitized.replace(/(password|passwd|secret|token)["']?\s*[:=]\s*["']?([^"',\s\r\n]+)/gi, "$1=[REDACTED]");

  return sanitized;
}

export function sanitizeObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return sanitizeSecrets(obj) as unknown as T;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (
      /password|secret|token|authorization|apikey|api_key/i.test(key) &&
      typeof val === "string"
    ) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = sanitizeObject(val);
    }
  }
  return result as T;
}

/**
 * Crash-safe atomic file writing:
 * 1. Write to temp file in same directory.
 * 2. fsync to force flushing bytes to storage device.
 * 3. Atomic rename to target path.
 */
export async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await fsp.mkdir(dir, { recursive: true });

  const tempPath = path.join(
    dir,
    `.tmp_${path.basename(targetPath)}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  );

  const fileHandle = await fsp.open(tempPath, "w");
  try {
    await fileHandle.writeFile(content, "utf-8");
    await fileHandle.sync(); // Force fsync to physical disk
  } finally {
    await fileHandle.close();
  }

  await fsp.rename(tempPath, targetPath);
}

export async function atomicWriteJson(targetPath: string, data: unknown): Promise<void> {
  const sanitized = sanitizeObject(data);
  const content = JSON.stringify(sanitized, null, 2);
  await atomicWriteFile(targetPath, content);
}

/**
 * Generate comprehensive summary.md for a run.
 */
export function generateRunSummaryMarkdown(run: RunMetadata): string {
  const lines: string[] = [
    `# Verity Run: \`${run.run_id}\``,
    ``,
    `**Status**: \`${run.status.toUpperCase()}\``,
    `**Original Goal**: ${run.original_goal}`,
    `**Current Goal**: ${run.current_goal || run.original_goal}`,
    `**Workspace**: \`${run.workspace}\``,
    `**Server Root**: \`${run.server_root}\``,
    `**Started At**: ${run.started_at}`,
    `**Last Updated**: ${run.updated_at}`,
    ``,
    `## Current Action in Flight`,
  ];

  if (run.current_action) {
    const title = typeof run.current_action === "string" ? run.current_action : run.current_action.title;
    lines.push(`- **Action**: ${title}`);
    if (run.current_purpose) lines.push(`- **Why**: ${run.current_purpose}`);
    if (run.current_target) {
      const tgt = typeof run.current_target === "object" ? JSON.stringify(run.current_target) : String(run.current_target);
      lines.push(`- **Target**: \`${tgt}\``);
    }
  } else {
    lines.push(`_None (idle / completed)_`);
  }

  lines.push(``, `## Phases & Milestones`);
  if (run.phases && run.phases.length > 0) {
    for (const ph of run.phases) {
      const mark = ph.status === "completed" ? "✓" : ph.status === "in_progress" ? "●" : ph.status === "failed" ? "×" : "○";
      lines.push(`- [${mark}] **${ph.title}** (\`${ph.status}\`)${ph.notes ? ` — ${ph.notes}` : ""}`);
    }
  } else {
    lines.push(`_No explicit phases configured._`);
  }

  lines.push(``, `## Completed Work (${run.completed_steps.length})`);
  if (run.completed_steps.length > 0) {
    for (const step of run.completed_steps) {
      lines.push(`- ✓ ${step}`);
    }
  } else {
    lines.push(`_No steps recorded as completed._`);
  }

  lines.push(``, `## Outstanding / Remaining Work (${run.pending_steps.length})`);
  if (run.pending_steps.length > 0) {
    for (const step of run.pending_steps) {
      lines.push(`- ○ ${step}`);
    }
  } else {
    lines.push(`_No pending steps recorded._`);
  }

  lines.push(``, `## Modified Files (${run.modified_files.length})`);
  if (run.modified_files.length > 0) {
    for (const f of run.modified_files) {
      lines.push(`- \`${f.path}\` (Op: \`${f.operation}\`, Reverted: ${f.reverted ? "Yes" : "No"})`);
    }
  } else {
    lines.push(`_No files modified._`);
  }

  lines.push(``, `## Active Resources`);
  lines.push(`- **Browser Sessions**: ${run.browser_sessions.filter((b) => b.active).length} active`);
  for (const b of run.browser_sessions.filter((b) => b.active)) {
    lines.push(`  - \`${b.id}\`${b.url ? ` (${b.url})` : ""}`);
  }
  lines.push(`- **Process Sessions**: ${run.process_sessions.filter((p) => p.running).length} running`);
  for (const p of run.process_sessions.filter((p) => p.running)) {
    lines.push(`  - PID ${p.pid || "?"}: \`${p.command}\``);
  }
  lines.push(`- **Worktrees**: ${run.worktrees.length}`);
  for (const w of run.worktrees) {
    lines.push(`  - \`${w.path}\` (${w.branch})`);
  }

  lines.push(``, `## Cleanup Debt (${run.cleanup_debt.filter((c) => !c.resolved).length} unresolved)`);
  if (run.cleanup_debt.length > 0) {
    for (const c of run.cleanup_debt) {
      const statusStr = c.resolved ? "RESOLVED" : "PENDING";
      lines.push(`- [${statusStr}] **${c.type}**: \`${c.path || c.resource_id}\`${c.description ? ` (${c.description})` : ""}`);
    }
  } else {
    lines.push(`_Zero cleanup debt._`);
  }

  return lines.join("\n") + "\n";
}
