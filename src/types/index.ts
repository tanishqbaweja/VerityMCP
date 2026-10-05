/**
 * VerityMCP - Core Domain Types
 */

export type StandardErrorCode =
  | "FILE_NOT_FOUND"
  | "FILE_CHANGED_SINCE_READ"
  | "PATCH_CONTEXT_MISMATCH"
  | "PATCH_VERIFICATION_FAILED"
  | "WORKTREE_DIRTY"
  | "BASH_NOT_AVAILABLE"
  | "WSL_UNAVAILABLE"
  | "PROCESS_NOT_FOUND"
  | "PROCESS_TIMEOUT"
  | "STALE_ELEMENT_REFERENCE"
  | "ELEMENT_NOT_VISIBLE"
  | "ELEMENT_NOT_EDITABLE"
  | "BROWSER_SESSION_NOT_FOUND"
  | "SCREENSHOT_WRITE_FAILED"
  | "TRACE_WRITE_FAILED"
  | "PATH_INVALID"
  | "GIT_CONFLICT"
  | "SECURITY_VIOLATION"
  | "INVALID_ARGUMENT"
  | "NOTEBOOK_INVALID"
  | "COMMAND_FAILED"
  | "INTERNAL_ERROR";

export interface ExecutionVerification {
  status: "passed" | "failed" | "not_performed";
  method: string;
  details?: Record<string, unknown>;
  error?: string;
}

export interface StateVerification {
  status: "passed" | "failed" | "not_performed" | "not_observable";
  method?: string;
  observed_changes?: Array<{
    type: string;
    before?: unknown;
    after?: unknown;
    description?: string;
  }>;
  details?: Record<string, unknown>;
  error?: string;
}

export interface VerificationResult {
  performed: boolean;
  passed: boolean;
  method: string;
  details?: Record<string, unknown>;
  error?: string;
  execution?: ExecutionVerification;
  state?: StateVerification;
}

export interface StandardToolResponse<T = unknown> {
  success: boolean;
  action: string;
  text: string;
  summary?: string;
  call_id?: string;
  display_title?: string;
  display_status?: "running" | "verified" | "completed" | "failed" | "warning" | "blocked";
  within_workspace?: boolean;
  workspace_root?: string;
  resolved_path?: string;
  warning?: string;
  warnings?: string[];
  stderr_present?: boolean;
  error_code?: StandardErrorCode | string;
  verification: VerificationResult;
  execution_verification?: ExecutionVerification;
  state_verification?: StateVerification;
  data?: T;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  durationMs?: number;
}

export type WorkspaceMode = "checkout" | "worktree";

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseRef: string;
}

export interface RepoMap {
  summary: string;
  primaryDirectories: string[];
  manifests: string[];
  scripts: Record<string, string>;
  dependencies: string[];
  languages: string[];
}

export interface Workspace {
  id: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorktreeInfo;
  instructions?: string;
  repoMap?: RepoMap;
  createdAt: number;
}

export interface VerityConfig {
  port: number;
  host: string;
  publicBaseUrl: string;
  ownerToken?: string;
  allowedRoots: string[];
  worktreesDir: string;
  defaultShell?: string;
}

export type ShellType = "bash" | "powershell" | "cmd" | "git-bash" | "wsl";

export interface ShellInfo {
  type: ShellType;
  available: boolean;
  executable: string;
  description: string;
  version?: string;
  status?: "healthy" | "available" | "unavailable" | "broken";
  healthProbe?: {
    healthy: boolean;
    reason?: string;
    version?: string;
  };
}

export interface DetectedShells {
  powershell: ShellInfo;
  cmd: ShellInfo;
  gitBash: ShellInfo;
  wsl: ShellInfo;
  defaultShell: ShellType;
}

export type ProcessStatus = "running" | "completed" | "failed" | "timed_out" | "interrupted";

export interface ProcessSession {
  id: string;
  command: string;
  shell: ShellType;
  shellPath: string;
  cwd: string;
  pid?: number;
  status: ProcessStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  wallTimeMs: number;
  isBackground: boolean;
  outputBuffer: Array<{ stream: "stdout" | "stderr"; text: string; timestamp: number }>;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface FileOutlineSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "method" | "type" | "variable" | "export";
  line: number;
  signature?: string;
}

export interface FileOutline {
  filePath: string;
  language: string;
  symbols: FileOutlineSymbol[];
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  source: "workspace" | "global";
}

export interface TaskItem {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  activeForm?: string;
  owner?: string;
  blocks?: string[];
  blockedBy?: string[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
