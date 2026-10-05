/**
 * DevSpace 4.0 - Core Domain Types
 */

export interface VerificationResult {
  performed: boolean;
  passed: boolean;
  method: string;
  details?: Record<string, unknown>;
  error?: string;
}

export interface StandardToolResponse<T = unknown> {
  success: boolean;
  action: string;
  text: string;
  verification: VerificationResult;
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

export interface DevSpaceConfig {
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
