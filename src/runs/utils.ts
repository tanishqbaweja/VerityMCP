import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { RunMetadata, RunMatchEvidence } from "./types.js";

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

  let attempts = 0;
  while (attempts < 5) {
    try {
      await fsp.rename(tempPath, targetPath);
      break;
    } catch (err: any) {
      attempts++;
      if (attempts >= 5 || (err.code !== "EPERM" && err.code !== "EBUSY")) {
        try {
          await fsp.copyFile(tempPath, targetPath);
          await fsp.unlink(tempPath).catch(() => {});
          break;
        } catch {
          throw err;
        }
      }
      await new Promise((r) => setTimeout(r, 10 * attempts));
    }
  }
}

export async function atomicWriteJson(targetPath: string, data: unknown): Promise<void> {
  const sanitized = sanitizeObject(data);
  const content = JSON.stringify(sanitized, null, 2);
  await atomicWriteFile(targetPath, content);
}

/**
 * Standard slugification for project keys, task keys, and tags.
 */
export function slugify(text: string): string {
  if (!text || typeof text !== "string") return "";
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are",
  "as", "at", "be", "because", "been", "before", "being", "below", "between", "both",
  "but", "by", "can", "cannot", "could", "did", "do", "does", "doing", "down", "during",
  "each", "few", "for", "from", "further", "had", "has", "have", "having", "he", "her",
  "here", "hers", "herself", "him", "himself", "his", "how", "i", "if", "in", "into",
  "is", "it", "its", "itself", "let", "me", "more", "most", "my", "myself", "no", "nor",
  "not", "of", "off", "on", "once", "only", "or", "other", "our", "ours", "ourselves",
  "out", "over", "own", "same", "she", "should", "so", "some", "such", "than", "that",
  "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they", "this",
  "those", "through", "to", "too", "under", "until", "up", "very", "was", "we", "were",
  "what", "when", "where", "which", "while", "who", "whom", "why", "with", "you", "your", "yours"
]);

/**
 * Tokenize significant words from a string, filtering out punctuation and stop words.
 */
export function extractWordTokens(text: string): string[] {
  if (!text || typeof text !== "string") return [];
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return Array.from(new Set(words));
}

/**
 * Derive durable task identity (project_key, task_key, tags, goal_fingerprint).
 */
export function deriveTaskIdentity(
  goal: string,
  workspace: string,
  options?: {
    projectKey?: string;
    taskKey?: string;
    tags?: string[];
  }
): {
  project_key: string;
  task_key: string;
  tags: string[];
  goal_fingerprint: string[];
} {
  // 1. project_key:
  let project_key = options?.projectKey ? slugify(options.projectKey) : "";
  if (!project_key) {
    const wsBase = path.basename(workspace);
    project_key = slugify(wsBase) || "default-project";
  }

  // 2. goal_fingerprint:
  const goal_fingerprint = extractWordTokens(goal);

  // 3. task_key:
  let task_key = options?.taskKey ? slugify(options.taskKey) : "";
  if (!task_key) {
    if (goal_fingerprint.length > 0) {
      task_key = slugify(goal_fingerprint.slice(0, 5).join("-"));
    } else {
      task_key = slugify(goal.slice(0, 40)) || "autonomous-run";
    }
  }

  // 4. tags:
  const derivedTags = new Set<string>();
  if (options?.tags && options.tags.length > 0) {
    for (const t of options.tags) {
      const s = slugify(t);
      if (s) derivedTags.add(s);
    }
  }

  // Seed tags from significant terms in goal:
  const commonKeywords = [
    "benchmark", "test", "browser", "perf", "performance", "build", "auth",
    "ui", "git", "fix", "refactor", "optimization", "harness", "migration",
    "database", "api", "security", "recovery", "monitor", "clean"
  ];
  for (const kw of commonKeywords) {
    if (goal.toLowerCase().includes(kw)) {
      derivedTags.add(kw);
    }
  }

  return {
    project_key,
    task_key,
    tags: Array.from(derivedTags),
    goal_fingerprint,
  };
}

/**
 * Multi-signal contextual run scoring algorithm for cross-chat discovery.
 */
export function computeRunMatchScore(
  run: RunMetadata,
  query: string,
  options?: {
    workspaceFilter?: string;
    projectKeyFilter?: string;
    taskKeyFilter?: string;
  }
): {
  match_percentage: number;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  match_details: RunMatchEvidence[];
} {
  const normQuery = query ? query.toLowerCase().trim() : "";
  const queryTokens = extractWordTokens(normQuery);
  const evidence: string[] = [];
  const match_details: RunMatchEvidence[] = [];

  let totalScore = 0;

  // Signal 1: task_key match (up to 35 pts)
  if (run.task_key) {
    const runTaskKey = run.task_key.toLowerCase();
    const targetTaskKey = options?.taskKeyFilter?.toLowerCase();

    if (targetTaskKey && (runTaskKey === targetTaskKey || runTaskKey.includes(targetTaskKey) || targetTaskKey.includes(runTaskKey))) {
      totalScore += 35;
      const desc = `Task key matched target filter "${run.task_key}" (+35%)`;
      evidence.push(desc);
      match_details.push({ signal: "task_key_filter", score: 35, description: desc });
    } else if (normQuery && (normQuery.includes(runTaskKey) || runTaskKey.includes(slugify(normQuery)))) {
      totalScore += 35;
      const desc = `Task key "${run.task_key}" matched query (+35%)`;
      evidence.push(desc);
      match_details.push({ signal: "task_key_query", score: 35, description: desc });
    } else {
      // Partial token overlap on task key
      const taskTokens = runTaskKey.split("-").filter(Boolean);
      const overlap = taskTokens.filter((t) => normQuery.includes(t) || queryTokens.includes(t));
      if (overlap.length >= 2) {
        const pts = Math.min(25, overlap.length * 8);
        totalScore += pts;
        const desc = `Task key tokens [${overlap.join(", ")}] match query (+${pts}%)`;
        evidence.push(desc);
        match_details.push({ signal: "task_key_partial", score: pts, description: desc });
      }
    }
  }

  // Signal 2: project_key & workspace match (up to 25 pts)
  if (options?.projectKeyFilter && run.project_key) {
    if (run.project_key.toLowerCase() === options.projectKeyFilter.toLowerCase()) {
      totalScore += 15;
      const desc = `Project key filter "${run.project_key}" matched (+15%)`;
      evidence.push(desc);
      match_details.push({ signal: "project_key_filter", score: 15, description: desc });
    }
  } else if (run.project_key && normQuery && (normQuery.includes(run.project_key.toLowerCase()) || run.project_key.toLowerCase().includes(slugify(normQuery)))) {
    totalScore += 15;
    const desc = `Project key "${run.project_key}" mentioned in query (+15%)`;
    evidence.push(desc);
    match_details.push({ signal: "project_key_query", score: 15, description: desc });
  }

  if (options?.workspaceFilter && run.workspace) {
    if (path.resolve(run.workspace) === path.resolve(options.workspaceFilter)) {
      totalScore += 10;
      const desc = `Workspace path exactly matched filter "${run.workspace}" (+10%)`;
      evidence.push(desc);
      match_details.push({ signal: "workspace_filter", score: 10, description: desc });
    }
  } else if (run.workspace && normQuery) {
    const wsBase = path.basename(run.workspace).toLowerCase();
    if (normQuery.includes(wsBase)) {
      totalScore += 10;
      const desc = `Workspace name "${wsBase}" found in query (+10%)`;
      evidence.push(desc);
      match_details.push({ signal: "workspace_query", score: 10, description: desc });
    }
  }

  // Signal 3: Goal & goal_fingerprint token overlap (up to 25 pts)
  if (queryTokens.length > 0 && run.goal_fingerprint && run.goal_fingerprint.length > 0) {
    const matchedTokens = queryTokens.filter((qt) =>
      run.goal_fingerprint!.some((gf) => gf === qt || gf.includes(qt) || qt.includes(gf))
    );
    if (matchedTokens.length > 0) {
      const ratio = matchedTokens.length / queryTokens.length;
      const pts = Math.min(25, Math.round(ratio * 25));
      totalScore += pts;
      const desc = `${matchedTokens.length}/${queryTokens.length} query tokens found in goal fingerprint [${matchedTokens.join(", ")}] (+${pts}%)`;
      evidence.push(desc);
      match_details.push({ signal: "goal_fingerprint", score: pts, description: desc });
    }
  } else if (queryTokens.length > 0) {
    // Fallback checking original goal directly
    const normGoal = run.original_goal.toLowerCase();
    const matched = queryTokens.filter((qt) => normGoal.includes(qt));
    if (matched.length > 0) {
      const pts = Math.min(20, Math.round((matched.length / queryTokens.length) * 20));
      totalScore += pts;
      const desc = `${matched.length}/${queryTokens.length} query tokens found in original goal (+${pts}%)`;
      evidence.push(desc);
      match_details.push({ signal: "goal_text", score: pts, description: desc });
    }
  }

  // Signal 4: Modified files / temporary artifacts / completed steps (up to 15 pts)
  let resourceMatched = false;
  if (run.modified_files && run.modified_files.length > 0 && normQuery) {
    for (const mf of run.modified_files) {
      const bname = path.basename(mf.path).toLowerCase();
      if (normQuery.includes(bname) || queryTokens.includes(bname)) {
        totalScore += 10;
        const desc = `Modified file "${bname}" matches query (+10%)`;
        evidence.push(desc);
        match_details.push({ signal: "modified_file", score: 10, description: desc });
        resourceMatched = true;
        break;
      }
    }
  }
  if (!resourceMatched && run.completed_steps && run.completed_steps.length > 0 && queryTokens.length > 0) {
    const completedStr = run.completed_steps.join(" ").toLowerCase();
    const stepMatches = queryTokens.filter((qt) => completedStr.includes(qt));
    if (stepMatches.length >= 2) {
      totalScore += 5;
      const desc = `Completed steps contain query terms [${stepMatches.join(", ")}] (+5%)`;
      evidence.push(desc);
      match_details.push({ signal: "completed_steps", score: 5, description: desc });
    }
  }

  // Signal 5: Status relevance (+5% for incomplete runs)
  if (run.status === "running" || run.status === "interrupted" || run.status === "needs_cleanup") {
    totalScore += 5;
    const desc = `Run is active or interrupted (${run.status}) (+5%)`;
    evidence.push(desc);
    match_details.push({ signal: "status_active", score: 5, description: desc });
  } else if (run.status === "completed" || run.status === "abandoned") {
    // If not an exact task key match, completed runs get small penalty so in-flight tasks rank higher
    if (totalScore < 50) {
      totalScore = Math.max(0, totalScore - 5);
      const desc = `Run already completed or abandoned (-5%)`;
      evidence.push(desc);
      match_details.push({ signal: "status_inactive", score: -5, description: desc });
    }
  }

  // Signal 6: Recency tie-breaker (up to +5%)
  try {
    const updatedTime = new Date(run.updated_at).getTime();
    const ageHours = (Date.now() - updatedTime) / (1000 * 60 * 60);
    if (ageHours < 2) {
      totalScore += 5;
      evidence.push("Recently active within 2 hours (+5%)");
      match_details.push({ signal: "recency", score: 5, description: "Active within 2h (+5%)" });
    } else if (ageHours < 24) {
      totalScore += 3;
      evidence.push("Active within 24 hours (+3%)");
      match_details.push({ signal: "recency", score: 3, description: "Active within 24h (+3%)" });
    }
  } catch {}

  const finalPercentage = Math.min(100, Math.max(0, Math.round(totalScore)));
  const confidence: "high" | "medium" | "low" =
    finalPercentage >= 70 ? "high" : finalPercentage >= 40 ? "medium" : "low";

  return {
    match_percentage: finalPercentage,
    confidence,
    evidence,
    match_details,
  };
}

/**
 * Generate comprehensive summary.md for a run.
 */
export function generateRunSummaryMarkdown(run: RunMetadata): string {
  const lines: string[] = [
    `# Verity Run: \`${run.run_id}\``,
    ``,
    `**Status**: \`${run.status.toUpperCase()}\``,
  ];

  if (run.project_key) lines.push(`**Project Key**: \`${run.project_key}\``);
  if (run.task_key) lines.push(`**Task Key**: \`${run.task_key}\``);
  if (run.tags && run.tags.length > 0) lines.push(`**Tags**: ${run.tags.map((t) => `\`${t}\``).join(", ")}`);
  if (run.idempotency_key) lines.push(`**Idempotency Key**: \`${run.idempotency_key}\``);

  lines.push(
    `**Original Goal**: ${run.original_goal}`,
    `**Current Goal**: ${run.current_goal || run.original_goal}`,
    `**Workspace**: \`${run.workspace}\``,
    `**Server Root**: \`${run.server_root}\``,
    `**Started At**: ${run.started_at}`,
    `**Last Updated**: ${run.updated_at}`,
    ``,
    `## Current Action in Flight`
  );

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

  const unresolvedDebt = run.cleanup_debt.filter((c) => !c.resolved);
  lines.push(``, `## Cleanup Debt (${unresolvedDebt.length} unresolved)`);
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
