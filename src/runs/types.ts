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
  created_at?: string;
  resolved: boolean;
  resolved_at?: string;
  resolution_reason?: string;
}

export interface TrackedTemporaryFile {
  id?: string;
  path: string;
  resolved_path?: string;
  tool?: string;
  purpose?: string;
  role?: "temporary_test" | "user_output" | "persistent_project_file";
  artifact_role?: "temporary_test" | "user_output" | "persistent_project_file";
  cleanup_required: boolean;
  created_at: string;
  deleted_at?: string;
  exists?: boolean;
  sha256?: string;
  deleted?: boolean;
  browser_session_id?: string;
  bytes?: number;
  width?: number;
  height?: number;
}

export interface TrackedBrowserSession {
  id: string;
  url?: string;
  created?: string;
  created_at?: string;
  updated_at?: string;
  status?: "active" | "closed" | "lost";
  cleanup_required?: boolean;
  last_known_state?: string;
  active: boolean;
  resolved_at?: string;
}

export interface TrackedProcessSession {
  id: string;
  pid?: number;
  command: string;
  command_summary?: string;
  running: boolean;
  cleanup_required?: boolean;
  started_at: string;
  completed_at?: string;
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
  internal_test?: boolean;
  run_kind?: "user" | "internal_test";
  acceptance_invocation_id?: string;
  test_kind?: string;
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
  current_action?: ActivityEvent | string | null;
  last_completed_action?: ActivityEvent | string | null;
  last_failed_action?: ActivityEvent | string | null;
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

export interface RunResourceSummary {
  browsers: {
    active: number;
    historical: number;
    total: number;
  };
  processes: {
    running: number;
    historical: number;
    total: number;
  };
  worktrees: {
    active: number;
    historical: number;
    total: number;
  };
  artifacts: {
    existingTemporary: number;
    historicalTemporary: number;
    total: number;
  };
  cleanupDebt: {
    unresolved: number;
    resolved: number;
  };
}

export interface RunIndexItem {
  run_id: string;
  project_key?: string;
  task_key?: string;
  goal: string;
  status: RunStatus;
  workspace: string;
  started_at: string;
  updated_at: string;
  server_pid?: number;
  server_instance_id?: string;
  is_internal: boolean;
  run_kind?: "user" | "internal_test";
  cleanup_debt_unresolved: number;
  last_action?: string;
  current_phase?: string;
  completed_steps_count: number;
}

export interface RunIndexSummary {
  total: number;
  user_runs: number;
  internal_test_runs: number;
  internal_test_runs_running: number;
  acceptance_run_leaks: number;
  running_runs: number;
  interrupted_runs: number;
  needs_cleanup_runs: number;
  completed_runs: number;
  failed_runs: number;
  abandoned_runs: number;
  items: RunIndexItem[];
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
  resource_summary?: RunResourceSummary;
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
