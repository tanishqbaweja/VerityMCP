import type { ActivityEvent } from "../observability/activity_stream.js";

export type RunStatus =
  | "running"
  | "interrupted"
  | "completed"
  | "needs_cleanup"
  | "failed"
  | "abandoned";

export interface Phase {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  notes?: string;
}

export interface ModifiedFile {
  path: string;
  pre_hash?: string;
  post_hash?: string;
  operation: string;
  timestamp: string;
  reverted?: boolean;
  temporary_mutation?: boolean;
  cleanup_required?: boolean;
}

export interface CleanupDebtItem {
  id: string;
  type: "temporary_file" | "browser_session" | "process_session" | "worktree";
  path?: string;
  resource_id?: string;
  description?: string;
  resolved: boolean;
  resolved_at?: string;
}

export interface TrackedTemporaryFile {
  path: string;
  tool?: string;
  purpose?: string;
  role?: "temporary_test" | "user_output" | "persistent_project_file";
  cleanup_required: boolean;
  created_at: string;
  deleted?: boolean;
}

export interface TrackedBrowserSession {
  id: string;
  url?: string;
  created: string;
  status?: "active" | "closed";
  cleanup_required?: boolean;
  last_known_state?: string;
  active: boolean;
}

export interface TrackedProcessSession {
  id: string;
  pid?: number;
  command: string;
  command_summary?: string;
  running: boolean;
  cleanup_required?: boolean;
  started_at: string;
  exit_code?: number | null;
}

export interface TrackedWorktree {
  path: string;
  branch: string;
  dirty?: boolean;
  cleanup_required?: boolean;
  created_at: string;
}

export interface Checkpoint {
  checkpoint_id: string;
  timestamp: string;
  completed: string[];
  current?: string;
  pending: string[];
  phases?: Phase[];
  notes?: string;
}

export interface RunMetadata {
  run_id: string;
  project_key?: string;
  task_key?: string;
  tags?: string[];
  search_terms?: string[];
  goal_fingerprint?: string[];
  idempotency_key?: string;
  origin_conversation_id?: string;
  associated_conversation_ids?: string[];
  adopted_at?: string;
  server_instance_id?: string;
  heartbeat_at?: string;
  started_at: string;
  updated_at: string;
  status: RunStatus;
  original_goal: string;
  current_goal: string;
  workspace: string;
  workspace_id?: string;
  server_root: string;
  current_action?: ActivityEvent | string;
  current_purpose?: string;
  current_target?: any;
  completed_steps: string[];
  pending_steps: string[];
  phases: Phase[];
  warnings: string[];
  failures: string[];
  modified_files: ModifiedFile[];
  temporary_files: TrackedTemporaryFile[];
  browser_sessions: TrackedBrowserSession[];
  process_sessions: TrackedProcessSession[];
  worktrees: TrackedWorktree[];
  cleanup_debt: CleanupDebtItem[];
  last_checkpoint?: Checkpoint;
  last_activity_cursor: number;
  server_pid?: number;
  metadata?: Record<string, unknown>;
}

export interface ActiveRunPointer {
  run_id: string;
  status: RunStatus;
  project_key?: string;
  task_key?: string;
  last_checkpoint?: string;
  workspace: string;
  started_at: string;
  updated_at: string;
  server_pid: number;
  server_instance_id?: string;
  heartbeat_at?: string;
}

export interface RunMatchEvidence {
  signal: string;
  score: number;
  description: string;
}

export interface RunCandidate {
  run_id: string;
  match_percentage: number;
  confidence: "high" | "medium" | "low";
  status: RunStatus;
  project_key?: string;
  task_key?: string;
  workspace: string;
  original_goal: string;
  current_phase?: string;
  evidence: string[];
  match_details: RunMatchEvidence[];
  updated_at: string;
  started_at: string;
  completed_steps_count: number;
}

export interface FindRunsResult {
  query: string;
  candidates: RunCandidate[];
  top_match?: RunCandidate;
  is_ambiguous: boolean;
  ambiguity_reason?: string;
  recommended_action: "adopt_top_match" | "ask_user_choice" | "start_new_run" | "none_found";
}

export interface RunResumeResult {
  recovered_run_id: string;
  status: RunStatus;
  project_key?: string;
  task_key?: string;
  original_goal: string;
  current_goal: string;
  workspace: string;
  completed_steps: string[];
  in_progress_when_interrupted?: string;
  last_successful_action?: string;
  current_remaining_steps: string[];
  phases: Phase[];
  active_resources: {
    browser_sessions: TrackedBrowserSession[];
    process_sessions: TrackedProcessSession[];
    worktrees: TrackedWorktree[];
  };
  modified_files: ModifiedFile[];
  temporary_artifacts: TrackedTemporaryFile[];
  cleanup_debt: CleanupDebtItem[];
  reconciliation: {
    modified_files_reconciled: Array<{ path: string; current_hash?: string; matches_post_hash: boolean; exists: boolean }>;
    git_clean: boolean;
    git_branch?: string;
    browser_sessions_alive: string[];
    process_sessions_alive: string[];
    warnings: string[];
  };
  last_checkpoint?: Checkpoint;
  last_checkpoint_timestamp?: string;
  instruction_for_agent: string;
}
