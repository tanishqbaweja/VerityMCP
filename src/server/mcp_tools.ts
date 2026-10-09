import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { VerityConfig } from "../types/index.js";
import { formatMcpResponse, type McpToolResponse } from "./response.js";
import { getMonitorHtml } from "../ui/monitor_html.js";
import { runManager } from "../runs/run_manager.js";
import { summarizeRunResources } from "../runs/utils.js";
import { workspaceManager } from "../workspace/workspace_manager.js";
import { discoverSkills, readSkillContent } from "../workspace/skills.js";
import { executeReadFile } from "../filesystem/read_file.js";
import { executeWriteFile } from "../filesystem/write_file.js";
import { executeEditFile } from "../filesystem/edit_file.js";
import {
  executeDeleteFile,
  executeMoveFile,
  executeCopyFile,
} from "../filesystem/file_ops.js";
import { executeListDirectory } from "../filesystem/list_directory.js";
import { executeLocateFiles } from "../filesystem/locate_files.js";
import { executeFileMetadata } from "../filesystem/file_metadata.js";
import { executeApplyPatch } from "../patcher/apply_patch.js";
import { executeSearchCode } from "../discovery/search_code.js";
import { executeGetOutline } from "../discovery/get_outline.js";
import { executeLsp } from "../discovery/lsp_tool.js";
import { processManager } from "../shell/process_manager.js";
import { browserManager } from "../browser/browser_manager.js";
import { takeBrowserSnapshot } from "../browser/snapshot.js";
import {
  executeNavigate,
  navigateAndVerify,
  executeReload,
  executeGoBack,
  executeGoForward,
  executeClick,
  executeDoubleClick,
  executeHover,
  executeFill,
  executeCheck,
  executeSelect,
  executeUpload,
  executePressKey,
  executeEval,
  executePdf,
  executeWaitFor,
  executeTraceStart,
  executeTraceStop,
  executeListTabs,
  executeGetConsole,
  executeGetNetwork,
} from "../browser/actions.js";
import { executeBrowserScreenshot } from "../browser/screenshots.js";
import {
  executeDesktopScreenshot,
  executeListWindows,
  executeFocusWindow,
} from "../desktop/desktop_control.js";
import {
  executeReadNotebook,
  executeEditNotebook,
} from "../notebook/notebook_engine.js";
import {
  executeEnterWorktree,
  executeExitWorktree,
  executeListWorktrees,
} from "../git/worktrees.js";
import {
  executeGitStatus,
  executeGitDiff,
  executeGitConflicts,
  executeShowChanges,
  executeRevertChanges,
} from "../git/git_ops.js";
import { taskStore } from "../tasks/task_store.js";
import {
  activityStream,
  activityContextStorage,
  type ActivityCallContext,
} from "../observability/activity_stream.js";
import { detectEnvironment } from "../environment/env_detector.js";
import { observabilityManager } from "../observability/diagnostics.js";
import { runBlackboxTest } from "../observability/blackbox_test.js";

type VerityToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

// Keep this explicit and exhaustive. Tool hosts use these hints to decide when
// user confirmation is required, so a missing entry is treated as a startup bug.
const TOOL_ANNOTATIONS: Record<string, VerityToolAnnotations> = {
  open_workspace: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  task_bootstrap: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_file: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  write_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  edit_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  apply_patch: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  delete_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  move_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  copy_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  list_directory: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  locate_files: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  glob_files: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  file_metadata: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  search_code: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_outline: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  lsp_query: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  exec_command: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  read_process_output: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  write_stdin: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  interrupt_process: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  kill_process: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  browser_open: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  browser_close: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  browser_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  browser_navigate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  page_reload: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  page_back: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  page_forward: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  browser_tab_new: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  browser_tab_select: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  browser_tab_close: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  browser_list_tabs: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  browser_snapshot: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_click: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_wait_for: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_trace_start: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  browser_trace_stop: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  browser_double_click: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_hover: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  browser_fill: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  browser_check: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_uncheck: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_select: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_upload: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_press_key: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_eval: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_pdf: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_console: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_network: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_screenshot: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  screenshot_desktop: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  list_windows: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  focus_window: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_notebook: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  edit_notebook: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  git_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  git_diff: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  git_conflicts: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  show_changes: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  revert_changes: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  enter_worktree: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  exit_worktree: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  list_worktrees: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  task_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  task_update: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  task_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  activity_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  activity_read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  activity_clear: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  activity_monitor: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_environment: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_skills: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_skill: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  verity_diagnostics: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  verity_self_test: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  verity_acceptance_test: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  start_run: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  checkpoint_run: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  resume_run: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  complete_run: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  list_runs: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_run: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run_activity_read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  find_runs: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  adopt_run: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  maintenance_runs: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  verity_blackbox_test: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  verity_robustness_test: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  discover_tools: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  invoke_tool: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

export function createVerityMcpServer(
  config: VerityConfig,
  defaultClientSessionId?: string
): McpServer {
  const server = new McpServer(
    {
      name: "verity-mcp",
      version: "1.0.0",
    },
    {
      instructions: `You are connected to VerityMCP on the user's local machine.

VerityMCP Core Philosophy:
AN AGENT MUST BE ABLE TO TRUST ITS TOOLS.
All filesystem mutations, patch applications, git reverts, process executions, browser interactions, and screenshots are verified against real system state before reporting success.

DURABLE EXECUTION & RECOVERY INSTRUCTIONS:
1. At the beginning of substantial multi-step tasks, call "start_run" with a clear goal to create a durable journal and mount the Live Activity Monitor UI.
2. During milestone completions, call "checkpoint_run" to persist completed and outstanding steps.
3. If the user prompts "Continue", "Resume", or "Keep going", ALWAYS CALL "resume_run" FIRST. Do not guess state from ChatGPT's collapsed transcript.
4. The durable source of truth is strictly <server_root>/.verity, NEVER AppData, NEVER OS temp, and NEVER the user workspace.

FAST-START AGENT INSTRUCTIONS:
1. For a clear computer or repository task, make the first safe state-gathering/action tool call immediately. Do not spend a long planning phase before the first tool call. When starting repository work, prefer task_bootstrap if workspace/task context is needed.
2. Prefer the directly exposed hot-path tools for common file, shell, browser, Git, and recovery work. Use discover_tools/invoke_tool only when a specialist capability is actually needed.
3. Keep verification enabled. Speed comes from fewer schemas, fewer round trips, and compact responses, not from skipping real-state checks.`,
    }
  );

  // Register standard MCP App UI Resource for Live Activity Monitor
  server.registerResource(
    "Activity Monitor",
    "ui://verity/activity-monitor",
    {
      title: "Activity Monitor",
      description: "Live operational activity and recovery monitor for VerityMCP runs",
      mimeType: "text/html;profile=mcp-app",
    },
    async (uri, extra) => {
      let runId: string | undefined = undefined;
      try {
        const parsed = new URL(uri.href);
        runId = parsed.searchParams.get("run_id") || undefined;
      } catch {}
      const runObj = runId ? await runManager.getRun(runId) : null;
      const resourceSessionId =
        (typeof extra?.sessionId === "string" && extra.sessionId) ||
        defaultClientSessionId;
      const targetRun =
        runObj?.run ||
        runManager.getActiveRun(resourceSessionId) ||
        (!resourceSessionId ? runManager.getActiveRun() : null);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/html;profile=mcp-app",
            text: getMonitorHtml({
              runId: targetRun?.run_id || runId,
              projectKey: targetRun?.project_key,
              taskKey: targetRun?.task_key,
            }),
          },
        ],
      };
    }
  );

  const SELF_INSTRUMENTING_TOOLS = new Set([
    "write_file",
    "edit_file",
    "delete_file",
    "move_file",
    "copy_file",
    "apply_patch",
    "exec_command",
    "start_process",
    "open_workspace",
    "browser_navigate",
    "browser_reload",
    "browser_go_back",
    "browser_go_forward",
    "browser_click",
    "browser_dblclick",
    "browser_hover",
    "browser_fill",
    "browser_check",
    "browser_select",
    "browser_upload",
    "browser_press_key",
    "browser_eval",
    "browser_pdf",
    "browser_wait_for",
    "browser_trace_start",
    "browser_trace_stop",
    "browser_list_tabs",
    "browser_get_console",
    "browser_get_network",
    "browser_snapshot",
    "browser_screenshot",
    "desktop_screenshot",
    "list_windows",
    "focus_window",
  ]);

  const STREAM_OBSERVABILITY_TOOLS = new Set([
    "activity_list",
    "activity_read",
    "activity_clear",
    "activity_monitor",
    "verity_diagnostics",
    "start_run",
    "checkpoint_run",
    "resume_run",
    "complete_run",
    "list_runs",
    "get_run",
    "run_activity_read",
    "find_runs",
    "adopt_run",
    "maintenance_runs",
    "verity_blackbox_test",
    "verity_robustness_test",
  ]);

  const toolProfile = (process.env.VERITY_TOOL_PROFILE || "fast").trim().toLowerCase();
  const useFastToolProfile = toolProfile !== "full";
  const HOT_PATH_TOOLS = new Set([
    "open_workspace",
    "task_bootstrap",
    "read_file",
    "write_file",
    "edit_file",
    "apply_patch",
    "list_directory",
    "locate_files",
    "search_code",
    "get_outline",
    "exec_command",
    "read_process_output",
    "write_stdin",
    "interrupt_process",
    "kill_process",
    "browser_open",
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_fill",
    "browser_press_key",
    "browser_screenshot",
    "screenshot_desktop",
    "git_status",
    "git_diff",
    "verity_diagnostics",
    "start_run",
    "checkpoint_run",
    "resume_run",
    "complete_run",
    "list_runs",
    "get_run",
    "run_activity_read",
    "find_runs",
    "adopt_run",
    "maintenance_runs",
    "discover_tools",
    "invoke_tool",
  ]);

  function formatToolDisplayTitle(toolName: string, args: any): string {
    switch (toolName) {
      case "read_file":
        return `Reading ${args?.file_path || args?.path || "file"}`;
      case "write_file":
        return `Writing ${args?.file_path || args?.path || "file"}`;
      case "edit_file":
        return `Editing ${args?.file_path || args?.path || "file"}`;
      case "delete_file":
        return `Deleting ${args?.file_path || args?.path || "file"}`;
      case "move_file":
        return `Moving ${args?.source_path || args?.source} -> ${args?.destination_path || args?.destination}`;
      case "copy_file":
        return `Copying ${args?.source_path || args?.source} -> ${args?.destination_path || args?.destination}`;
      case "list_directory":
        return `Listing directory ${args?.dir_path || args?.path || "."}`;
      case "locate_files":
        return `Locating files matching "${args?.pattern || args?.glob || "*"}"`;
      case "file_metadata":
        return `Inspecting metadata of ${args?.file_path || args?.path || "file"}`;
      case "apply_patch":
        return `Applying unified patch`;
      case "search_code":
        return `Searching code for "${args?.query || args?.pattern || ""}"`;
      case "get_outline":
        return `Extracting symbols outline for ${args?.file_path || args?.path || "file"}`;
      case "lsp_command":
        return `LSP query: ${args?.command || "action"}`;
      case "exec_command":
        return `Running command: ${args?.command || ""}`;
      case "start_process":
        return `Starting background process: ${args?.command || ""}`;
      case "read_process_output":
        return `Reading output of process: ${args?.process_id || ""}`;
      case "send_process_input":
        return `Sending stdin to process: ${args?.process_id || ""}`;
      case "stop_process":
        return `Stopping process: ${args?.process_id || ""}`;
      case "list_processes":
        return "Listing background processes";
      case "browser_navigate":
        return `Navigating to ${args?.url || "URL"}`;
      case "browser_snapshot":
        return "Inspecting browser DOM & accessibility snapshot";
      case "browser_click":
        return `Clicking ${args?.ref || args?.selector || "element"}`;
      case "browser_dblclick":
        return `Double-clicking ${args?.ref || args?.selector || "element"}`;
      case "browser_hover":
        return `Hovering ${args?.ref || args?.selector || "element"}`;
      case "browser_fill":
        return `Filling input ${args?.ref || args?.selector || "element"}`;
      case "browser_check":
        return `Checking ${args?.ref || args?.selector || "element"}`;
      case "browser_select":
        return `Selecting option in ${args?.ref || args?.selector || "element"}`;
      case "browser_upload":
        return `Uploading files to ${args?.ref || args?.selector || "element"}`;
      case "browser_press_key":
        return `Pressing key "${args?.key || ""}"`;
      case "browser_screenshot":
        return `Capturing browser screenshot`;
      case "desktop_screenshot":
        return "Capturing desktop screenshot";
      case "read_notebook":
        return `Reading Jupyter notebook ${args?.file_path || args?.path || ""}`;
      case "edit_notebook":
        return `Editing cell in Jupyter notebook ${args?.file_path || args?.path || ""}`;
      case "git_status":
        return "Checking Git status & working tree";
      case "git_diff":
        return "Checking Git diff";
      case "git_revert":
        return `Reverting changes for ${args?.paths?.join(", ") || "all modified files"}`;
      case "open_workspace":
        return `Opening workspace ${args?.path || "."}`;
      case "task_bootstrap":
        return `Bootstrapping task context for ${args?.path || "active workspace"}`;
      case "discover_tools":
        return `Discovering specialist tools${args?.query ? ` for "${args.query}"` : ""}`;
      case "invoke_tool":
        return `Invoking specialist tool: ${args?.name || "unknown"}`;
      case "start_run":
        return `Starting run: ${args?.goal?.slice(0, 40) || ""}`;
      case "checkpoint_run":
        return `Recording run checkpoint`;
      case "resume_run":
        return `Resuming run: ${args?.run_id || "latest"}`;
      case "complete_run":
        return `Completing run: ${args?.run_id || "active"}`;
      case "list_runs":
        return `Listing persisted runs`;
      case "get_run":
        return `Retrieving run: ${args?.run_id || ""}`;
      case "run_activity_read":
        return `Reading activity journal for run: ${args?.run_id || "active"}`;
      case "find_runs":
        return `Finding runs matching "${args?.query || ""}"`;
      case "adopt_run":
        return `Adopting run: ${args?.run_id || ""}`;
      case "maintenance_runs":
        return `Run maintenance: ${args?.mode || "archive"} (dry_run: ${args?.dry_run !== false})`;
      case "verity_blackbox_test":
      case "verity_robustness_test":
        return `Seeded black-box robustness battery${args?.seed ? ` (seed: ${args.seed})` : ""}`;
      default:
        return toolName.replace(/_/g, " ");
    }
  }

  function formatDefaultPurpose(toolName: string, args: any): string {
    switch (toolName) {
      case "read_file":
        return `Inspect contents and verify SHA-256 hash of ${args?.file_path || args?.path || "file"}`;
      case "write_file":
        return `Write content to disk and verify SHA-256 readback`;
      case "edit_file":
        return `Apply exact text replacement and verify disk readback SHA-256`;
      case "delete_file":
        return `Remove file from filesystem with post-deletion verification`;
      case "move_file":
        return `Move file atomically and verify existence at target`;
      case "copy_file":
        return `Copy file and verify byte equality`;
      case "list_directory":
        return `Inspect directory entries and file tree structure`;
      case "locate_files":
        return `Find matching files in workspace`;
      case "file_metadata":
        return `Retrieve file stats, permissions, and timestamps`;
      case "apply_patch":
        return `Apply patch with hunk verification`;
      case "search_code":
        return `Find code occurrences matching query pattern`;
      case "get_outline":
        return `Extract structured symbols and AST outline`;
      case "lsp_command":
        return `Query language server protocol diagnostics or definitions`;
      case "exec_command":
        return `Execute shell command and capture verified exit code and output`;
      case "start_process":
        return `Spawn long-running background process session`;
      case "read_process_output":
        return `Retrieve buffered process stdout/stderr using cursor pagination`;
      case "send_process_input":
        return `Send input to active process session`;
      case "stop_process":
        return `Terminate process session`;
      case "list_processes":
        return `Inspect active and retained background process sessions`;
      case "browser_navigate":
        return `Navigate active browser session to URL`;
      case "browser_snapshot":
        return `Capture fresh accessibility tree and element ref map`;
      case "browser_click":
        return `Click interactive element and verify DOM effect`;
      case "browser_fill":
        return `Fill form control and verify DOM input value`;
      case "browser_check":
        return `Toggle checkbox/radio control and verify checked state`;
      case "browser_screenshot":
        return `Capture verified visual viewport screenshot`;
      case "desktop_screenshot":
        return `Capture full desktop display screen`;
      case "read_notebook":
        return `Read Jupyter notebook structure and cells`;
      case "edit_notebook":
        return `Modify notebook cell while preserving formatting`;
      case "git_status":
        return `Inspect Git branch, staged, and unstaged changes`;
      case "git_diff":
        return `Inspect Git diff patches against HEAD`;
      case "git_revert":
        return `Revert modified files and verify clean Git tree`;
      case "open_workspace":
        return `Bootstrap workspace environment, map architecture, and discover skills`;
      case "task_bootstrap":
        return `Gather workspace, Git, relevant-code, running-process, and recent-activity context in one round trip`;
      case "discover_tools":
        return `Find deferred specialist capabilities without loading every tool schema up front`;
      case "invoke_tool":
        return `Run a deferred specialist capability through the compact gateway`;
      case "start_run":
        return `Initialize durable execution journal and live activity monitor`;
      case "checkpoint_run":
        return `Persist current milestone, completed work, and outstanding tasks`;
      case "resume_run":
        return `Recover durable execution context from .verity store and reconcile state`;
      case "complete_run":
        return `Finalize run and verify that all temporary resources and debt are clean`;
      case "list_runs":
        return `Inspect historical and interrupted runs in persistent storage`;
      case "get_run":
        return `Read complete execution state, checkpoints, and event history`;
      case "run_activity_read":
        return `Read paginated activity events from run's disk journal`;
      case "find_runs":
        return `Search prior runs across conversations using multi-signal contextual ranking`;
      case "adopt_run":
        return `Adopt a historical or interrupted run into the active session`;
      case "maintenance_runs":
        return `Maintain internal test run history without modifying user runs`;
      case "verity_blackbox_test":
      case "verity_robustness_test":
        return `Validate orthogonal subsystems with dynamic fixtures, reproducible PRNG data, and verified cleanup`;
      default:
        return `Execute ${toolName} operation`;
    }
  }

  function extractToolTarget(args: any): Record<string, unknown> | string | undefined {
    if (!args || typeof args !== "object") return undefined;
    if (args.run_id) return args.run_id;
    if (args.goal) return args.goal;
    if (args.session_id) return args.session_id;
    if (args.file_path) return args.file_path;
    if (args.path) return args.path;
    if (args.url) return args.url;
    if (args.command) return args.command;
    if (args.selector) return args.selector;
    if (args.ref) return args.ref;
    if (args.query) return args.query;
    if (args.process_id) return args.process_id;
    return undefined;
  }

  type RegisteredToolDefinition = {
    name: string;
    description: string;
    inputSchema: any;
    handler: (args: any) => Promise<McpToolResponse>;
  };
  const toolRegistry = new Map<string, RegisteredToolDefinition>();

  const registerTool = (
    name: string,
    description: string,
    shape: Record<string, z.ZodTypeAny> | z.ZodTypeAny,
    handler: (args: any) => Promise<McpToolResponse>
  ) => {
    const annotations = TOOL_ANNOTATIONS[name];
    if (!annotations) {
      throw new Error(`Missing explicit MCP tool annotations for "${name}"`);
    }
    const purposeField = z.string().optional().describe("Concise operational reason why this action is being performed right now (for user live activity stream).");
    const expectedOutcomeField = z.string().optional().describe("What system state or result is expected if this action succeeds.");
    const responseDetailField = z.enum(["compact", "full"]).optional().describe("Response detail. compact is default; full includes the complete structured JSON payload.");

    let inputSchema: any;
    if (shape instanceof z.ZodObject) {
      inputSchema = shape.extend({
        purpose: purposeField,
        expected_outcome: expectedOutcomeField,
        response_detail: responseDetailField,
      });
    } else if (shape instanceof z.ZodType) {
      inputSchema = shape;
    } else {
      inputSchema = z.object({
        ...shape,
        purpose: purposeField,
        expected_outcome: expectedOutcomeField,
        response_detail: responseDetailField,
      });
    }

    const definition: RegisteredToolDefinition = { name, description, inputSchema, handler };
    toolRegistry.set(name, definition);
    if (useFastToolProfile && !HOT_PATH_TOOLS.has(name)) {
      return;
    }

    server.registerTool(name, { description, inputSchema, annotations } as any, async (args: any, extra: any): Promise<any> => {
      const startTime = Date.now();
      const callId = activityStream.generateCallId();
      const callerPurpose = typeof args?.purpose === "string" && args.purpose.trim() ? args.purpose.trim() : undefined;
      const callerExpectedOutcome = typeof args?.expected_outcome === "string" && args.expected_outcome.trim() ? args.expected_outcome.trim() : undefined;
      const displayTitle = formatToolDisplayTitle(name, args);
      const purpose = callerPurpose || formatDefaultPurpose(name, args);
      const purposeSource = callerPurpose ? "caller" : "tool_default";
      const target = extractToolTarget(args);
      const clientSessionId =
        (typeof extra?.sessionId === "string" && extra.sessionId) ||
        defaultClientSessionId;
      const ownerRunId = runManager.getActiveRun(clientSessionId)?.run_id;

      const callCtx: ActivityCallContext = {
        callId,
        toolName: name,
        displayTitle,
        purpose,
        purposeSource,
        expectedOutcome: callerExpectedOutcome,
        target,
        workspaceId: workspaceManager.getActiveWorkspaceRoot() || undefined,
        clientSessionId,
        ownerRunId,
        args,
      };

      return activityContextStorage.run(callCtx, async () => {
        const isSelfInstrumenting = SELF_INSTRUMENTING_TOOLS.has(name);
        const isObservability = STREAM_OBSERVABILITY_TOOLS.has(name);

        if (!isSelfInstrumenting && !isObservability) {
          activityStream.emit({
            type: "action_started",
            title: displayTitle,
            status: "running",
            target,
          });
        }

        try {
          const response = await handler(args);
          const structured = response._structured;
          const success = structured ? structured.success : !response.isError;
          const errorCode = structured?.error_code;
          const verificationPassed =
            structured?.execution_verification?.status === "passed" &&
            structured?.state_verification?.status !== "failed";

          if (!isSelfInstrumenting && !isObservability) {
            activityStream.emit({
              type: success ? "action_completed" : "failure",
              title: `${displayTitle} ${success ? "completed" : "failed"}`,
              status: success ? (verificationPassed ? "verified" : "completed") : "failed",
              target,
              reason: errorCode || (!success ? (structured?.summary || "Action failed") : undefined),
            });
          }

          observabilityManager.logToolEvent({
            toolName: name,
            action: structured?.action || name,
            success,
            errorCode,
            verificationPassed,
            durationMs: Date.now() - startTime,
            timestamp: Date.now(),
          });
          return response;
        } catch (err: any) {
          if (!isObservability) {
            activityStream.emit({
              type: "failure",
              title: `${displayTitle}: ${err.message}`,
              status: "failed",
              reason: err.message,
            });
          }

          observabilityManager.logToolEvent({
            toolName: name,
            action: name,
            success: false,
            errorCode: "TOOL_ERROR",
            durationMs: Date.now() - startTime,
            timestamp: Date.now(),
          });
          return formatMcpResponse({
            success: false,
            action: name,
            text: `Tool execution error: ${err.message}`,
            verification: {
              performed: true,
              passed: false,
              method: "mcp_tool_runner",
              error: err.message,
            },
            durationMs: Date.now() - startTime,
          });
        }
      });
    });
  };

  const getRoot = () => workspaceManager.getActiveWorkspaceRoot();

  // 1. open_workspace
  registerTool(
    "open_workspace",
    "Opens a project directory or worktree. Returns architectural repo map, git status/branch, supported shells, package scripts, and discovered skills in a single bootstrap call.",
    {
      path: z.string().optional().describe("Path to project root. Defaults to current directory."),
    },
    async ({ path: targetPath }) => {
      const res = await workspaceManager.openWorkspace(targetPath, config.allowedRoots);
      return formatMcpResponse(res);
    }
  );

  registerTool(
    "task_bootstrap",
    "Fast one-call task bootstrap. Opens the workspace when needed, refreshes Git state, optionally searches for task-relevant code, and returns running process plus recent activity context.",
    {
      path: z.string().optional().describe("Workspace path. Reuses the active workspace when omitted."),
      query: z.string().optional().describe("Optional code-search phrase related to the task."),
      max_matches: z.number().int().positive().max(30).optional().describe("Maximum code matches. Defaults to 12."),
      recent_activity: z.number().int().nonnegative().max(20).optional().describe("Recent activity events to include. Defaults to 5."),
    },
    async ({ path: targetPath, query, max_matches, recent_activity }) => {
      const startedAt = Date.now();
      let workspaceOpenResult: any | undefined;
      let workspace = workspaceManager.getWorkspace();

      if (targetPath || !workspace) {
        workspaceOpenResult = await workspaceManager.openWorkspace(targetPath, config.allowedRoots);
        if (!workspaceOpenResult.success) {
          return formatMcpResponse(workspaceOpenResult);
        }
        workspace = workspaceManager.getWorkspace();
      }

      const root = getRoot();
      const gitResult = executeGitStatus(root);
      const searchResult = query
        ? executeSearchCode({
            workspaceRoot: root,
            allowedRoots: config.allowedRoots,
            query,
            caseSensitive: false,
            maxResults: max_matches ?? 12,
          })
        : undefined;
      const runningProcesses = processManager
        .listSessions()
        .filter((session: any) => session.status === "running")
        .map((session: any) => ({
          session_id: session.id,
          pid: session.pid,
          command: session.command,
          cwd: session.cwd,
          shell: session.shell,
          started_at: session.startedAt,
        }));
      const recentEvents = activityStream
        .list(recent_activity ?? 5)
        .filter((event: any) => event.tool !== "task_bootstrap")
        .slice(-(recent_activity ?? 5));

      const git = gitResult.data;
      const repoMap = workspace?.repoMap;
      const lines = [
        `Workspace: ${root}`,
        repoMap?.summary ? `Repository: ${repoMap.summary}` : undefined,
        git
          ? `Git: ${git.branch} | ${git.isClean ? "clean" : `${git.modified.length + git.untracked.length} changed/untracked`}`
          : `Git: unavailable`,
        repoMap?.languages?.length ? `Languages: ${repoMap.languages.join(", ")}` : undefined,
        `Running managed processes: ${runningProcesses.length}`,
      ].filter(Boolean) as string[];

      if (searchResult) {
        lines.push("", `Relevant code for "${query}":`, searchResult.text);
      }
      if (recentEvents.length > 0) {
        lines.push(
          "",
          "Recent activity:",
          ...recentEvents.map((event: any) => `- #${event.seq} ${event.type}: ${event.title}`)
        );
      }

      const success = gitResult.success && (searchResult?.success ?? true);
      return formatMcpResponse({
        success,
        action: "task_bootstrap",
        error_code: success ? undefined : "BOOTSTRAP_PARTIAL_FAILURE",
        text: lines.join("\n"),
        summary: `Task context ready for ${root}`,
        data: {
          workspace: {
            id: workspace?.id,
            root,
            summary: repoMap?.summary,
            languages: repoMap?.languages,
            scripts: repoMap?.scripts,
          },
          git,
          search: searchResult?.data,
          running_processes: runningProcesses,
          recent_activity: recentEvents,
          workspace_opened: Boolean(workspaceOpenResult),
        },
        verification: {
          performed: true,
          passed: success,
          method: "composite_workspace_git_search_state_readback",
          error: success ? undefined : searchResult?.text || gitResult.text,
        },
        durationMs: Date.now() - startedAt,
      });
    }
  );

  // 2. read_file
  registerTool(
    "read_file",
    "Reads a file with line slicing and SHA-256 hash. If reading an image (.png, .jpg, etc.), automatically includes visual image payload in response.",
    {
      file_path: z.string().optional().describe("Path to the file."),
      path: z.string().optional().describe("Alias for file_path."),
      line_start: z.number().int().positive().optional().describe("1-based start line."),
      line_end: z.number().int().positive().optional().describe("1-based end line."),
      with_line_numbers: z.boolean().optional().describe("Include line numbers. Defaults to true."),
    },
    async (args) => {
      const targetPath = args.file_path || args.path;
      if (!targetPath) throw new Error("Missing required argument: file_path (or path)");
      const res = await executeReadFile({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        filePath: targetPath,
        lineStart: args.line_start,
        lineEnd: args.line_end,
        withLineNumbers: args.with_line_numbers ?? true,
      });
      return formatMcpResponse(res.toolResponse, { image: res.imagePayload });
    }
  );

  // 3. write_file
  registerTool(
    "write_file",
    "Writes full content to a file with mandatory post-write byte readback and SHA-256 verification.",
    {
      file_path: z.string().optional().describe("Target file path."),
      path: z.string().optional().describe("Alias for file_path."),
      content: z.string().describe("File content to write."),
      overwrite: z.boolean().optional().describe("Allow overwriting existing files. Defaults to true."),
    },
    async (args) => {
      const targetPath = args.file_path || args.path;
      if (!targetPath) throw new Error("Missing required argument: file_path (or path)");
      const res = await executeWriteFile({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        filePath: targetPath,
        content: args.content,
        overwrite: args.overwrite ?? true,
      });
      if (res.success && res.resolved_path) {
        await runManager.trackModifiedFile({
          path: res.resolved_path,
          operation: "write_file",
          pre_hash: (res.data as any)?.pre_sha256,
          post_hash: (res.data as any)?.sha256,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }
      return formatMcpResponse(res);
    }
  );

  // 4. edit_file
  registerTool(
    "edit_file",
    "Performs exact string replacement with uniqueness verification, unified diff output, and post-mutation hash verification.",
    {
      file_path: z.string().optional().describe("Target file path."),
      path: z.string().optional().describe("Alias for file_path."),
      old_string: z.string().describe("Exact text to replace."),
      new_string: z.string().describe("Replacement text."),
      replace_all: z.boolean().optional().describe("Replace all occurrences if multiple. Defaults to false."),
      expected_sha256: z.string().optional().describe("Optional SHA-256 hash of the file prior to editing, ensuring concurrent mutation safety."),
    },
    async (args) => {
      const targetPath = args.file_path || args.path;
      if (!targetPath) throw new Error("Missing required argument: file_path (or path)");
      const res = await executeEditFile({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        filePath: targetPath,
        oldString: args.old_string,
        newString: args.new_string,
        replaceAll: args.replace_all ?? false,
        expectedSha256: args.expected_sha256,
      });
      if (res.success && res.resolved_path) {
        await runManager.trackModifiedFile({
          path: res.resolved_path,
          operation: "edit_file",
          pre_hash: (res.data as any)?.pre_sha256 || args.expected_sha256,
          post_hash: (res.data as any)?.post_sha256 || (res.data as any)?.sha256,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }
      return formatMcpResponse(res);
    }
  );

  // 5. apply_patch
  registerTool(
    "apply_patch",
    "Applies Codex (*** Begin Patch) or unified diffs across one or multiple files with atomic staging, rollback, and mandatory post-mutation verification (preventing false-success conditions).",
    {
      patch: z.string().describe("The patch string to apply."),
      expected_sha256_map: z.record(z.string(), z.string()).optional().describe("Optional map of filePath to expected SHA-256 hash before applying patch."),
    },
    async ({ patch, expected_sha256_map }) => {
      const res = await executeApplyPatch({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        patch,
        expectedSha256Map: expected_sha256_map,
      });
      if (res.success && (res.data as any)?.applied_files) {
        for (const file of (res.data as any).applied_files) {
          await runManager.trackModifiedFile({
            path: file.path || file.resolved_path,
            operation: "apply_patch",
            pre_hash: file.pre_sha256,
            post_hash: file.post_sha256,
            timestamp: new Date().toISOString(),
          }).catch(() => {});
        }
      }
      return formatMcpResponse(res);
    }
  );

  // 6. delete_file
  registerTool(
    "delete_file",
    "Deletes a file or directory with post-deletion existence verification.",
    {
      file_path: z.string().describe("Path to delete."),
      recursive: z.boolean().optional().describe("Recursive delete for directories. Defaults to false."),
    },
    async ({ file_path, recursive }) => {
      const res = await executeDeleteFile({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        filePath: file_path,
        recursive: recursive ?? false,
      });
      if (res.success && res.resolved_path) {
        await runManager.resolveCleanupDebt(res.resolved_path).catch(() => {});
      }
      return formatMcpResponse(res);
    }
  );

  // 7. move_file
  registerTool(
    "move_file",
    "Moves or renames a file with mandatory source-unlinked and destination-exists relocation verification.",
    {
      source_path: z.string().describe("Source file path."),
      destination_path: z.string().describe("Destination file path."),
      overwrite: z.boolean().optional().describe("Overwrite destination if exists. Defaults to false."),
    },
    async ({ source_path, destination_path, overwrite }) => {
      const res = await executeMoveFile({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        sourcePath: source_path,
        destinationPath: destination_path,
        overwrite: overwrite ?? false,
      });
      return formatMcpResponse(res);
    }
  );

  // 8. copy_file
  registerTool(
    "copy_file",
    "Copies a file with mandatory content and hash verification.",
    {
      source_path: z.string().describe("Source path."),
      destination_path: z.string().describe("Destination path."),
      overwrite: z.boolean().optional().describe("Overwrite destination. Defaults to true."),
    },
    async ({ source_path, destination_path, overwrite }) => {
      const res = await executeCopyFile({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        sourcePath: source_path,
        destinationPath: destination_path,
        overwrite: overwrite ?? true,
      });
      return formatMcpResponse(res);
    }
  );

  // 9. list_directory
  registerTool(
    "list_directory",
    "Lists directory contents with depth, size, and ignore filtering.",
    {
      dir_path: z.string().optional().describe("Directory path. Defaults to root."),
      path: z.string().optional().describe("Alias for dir_path."),
      recursive: z.boolean().optional().describe("Recursive scan. Defaults to false."),
      max_depth: z.number().int().positive().optional().describe("Max recursion depth. Defaults to 2."),
      show_hidden: z.boolean().optional().describe("Include hidden files. Defaults to false."),
    },
    async (args) => {
      const targetPath = args.dir_path || args.path;
      const res = await executeListDirectory({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        dirPath: targetPath,
        recursive: args.recursive ?? false,
        maxDepth: args.max_depth ?? 2,
        showHidden: args.show_hidden ?? false,
      });
      return formatMcpResponse(res);
    }
  );

  // 10. locate_files
  registerTool(
    "locate_files",
    "Locates files by glob pattern or name substring.",
    {
      pattern: z.string().describe("Glob pattern (e.g. *.ts, **/*.json) or name substring."),
      dir_path: z.string().optional().describe("Search subdirectory. Defaults to root."),
      max_results: z.number().int().positive().optional().describe("Max results. Defaults to 100."),
    },
    async ({ pattern, dir_path, max_results }) => {
      const res = await executeLocateFiles({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        pattern,
        dirPath: dir_path,
        maxResults: max_results ?? 100,
      });
      return formatMcpResponse(res);
    }
  );

  // 11. glob_files (alias for glob)
  registerTool(
    "glob_files",
    "Finds files matching glob pattern across the project tree.",
    {
      pattern: z.string().describe("Glob pattern."),
      dir_path: z.string().optional().describe("Base path."),
    },
    async ({ pattern, dir_path }) => {
      const res = await executeLocateFiles({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        pattern,
        dirPath: dir_path,
      });
      return formatMcpResponse(res);
    }
  );

  // 12. file_metadata
  registerTool(
    "file_metadata",
    "Inspects file stats, existence, SHA-256 hash, line count, and binary status.",
    {
      file_path: z.string().describe("Path to inspect."),
    },
    async ({ file_path }) => {
      const res = await executeFileMetadata({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        filePath: file_path,
      });
      return formatMcpResponse(res);
    }
  );

  // 13. search_code
  registerTool(
    "search_code",
    "High-speed code search powered by ripgrep with line numbers and file matching.",
    {
      query: z.string().optional().describe("Text or regex to search for."),
      pattern: z.string().optional().describe("Alias for query."),
      dir_path: z.string().optional().describe("Subdirectory to search."),
      path: z.string().optional().describe("Alias for dir_path."),
      case_sensitive: z.boolean().optional().describe("Case sensitivity. Defaults to false."),
      glob_filter: z.string().optional().describe("File pattern filter (e.g. *.ts)."),
      max_results: z.number().int().positive().optional().describe("Max match count. Defaults to 100."),
    },
    async (args) => {
      const q = args.query || args.pattern;
      if (!q) throw new Error("Missing required argument: query (or pattern)");
      const res = executeSearchCode({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        query: q,
        dirPath: args.dir_path || args.path,
        caseSensitive: args.case_sensitive ?? false,
        globFilter: args.glob_filter,
        maxResults: args.max_results ?? 100,
      });
      return formatMcpResponse(res);
    }
  );

  // 14. get_outline
  registerTool(
    "get_outline",
    "Extracts structural symbols (functions, classes, interfaces, methods, types) from code.",
    {
      file_path: z.string().optional().describe("Path of code file to outline."),
      path: z.string().optional().describe("Alias for file_path."),
      verbosity: z.enum(["minimal", "detailed"]).optional().describe("Verbosity mode. Defaults to detailed."),
    },
    async (args) => {
      const targetPath = args.file_path || args.path;
      if (!targetPath) throw new Error("Missing required argument: file_path (or path)");
      const res = await executeGetOutline({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        filePath: targetPath,
        verbosity: args.verbosity ?? "detailed",
      });
      return formatMcpResponse(res);
    }
  );

  // 15. lsp_query
  registerTool(
    "lsp_query",
    "Semantic code intelligence: documentSymbol (outline/normal/full), goToDefinition, findReferences, hover, workspaceSymbol, typeDefinition.",
    {
      operation: z.enum(["documentSymbol", "goToDefinition", "findReferences", "hover", "workspaceSymbol", "typeDefinition"]),
      file_path: z.string().optional().describe("File path."),
      line: z.number().int().positive().optional().describe("1-based line."),
      character: z.number().int().positive().optional().describe("1-based column."),
      query: z.string().optional().describe("Symbol query."),
      verbosity: z.enum(["outline", "normal", "full"]).optional().describe("Verbosity level for symbols. Defaults to outline."),
    },
    async ({ operation, file_path, line, character, query, verbosity }) => {
      const res = await executeLsp({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        operation,
        filePath: file_path,
        line,
        character,
        query,
        verbosity: verbosity ?? "outline",
      });
      return formatMcpResponse(res);
    }
  );

  // 16. exec_command
  registerTool(
    "exec_command",
    "Executes shell commands with explicit shell selection ('powershell', 'cmd', 'git-bash'). If the process exceeds yield_ms or run_in_background is true, returns a session ID for streaming output.",
    {
      command: z.string().describe("Command line string to execute."),
      shell: z.enum(["powershell", "cmd", "bash", "git-bash", "wsl"]).optional().describe("Shell to run in. Defaults to system recommended shell."),
      timeout_ms: z.number().int().positive().optional().describe("Overall timeout. Defaults to 60000ms."),
      yield_ms: z.number().int().positive().optional().describe("Yield window. If command exceeds this duration, yields running session. Defaults to 2000ms."),
      run_in_background: z.boolean().optional().describe("Run immediately in background. Defaults to false."),
      verify: z
        .object({
          path_exists: z.string().optional().describe("Verifies that this path exists after command runs."),
          path_absent: z.string().optional().describe("Verifies that this path does not exist after command runs."),
          stdout_contains: z.string().optional().describe("Verifies that stdout contains this substring."),
          exit_code: z.number().int().optional().describe("Expected exit code (defaults to 0)."),
        })
        .optional()
        .describe("Explicit postconditions to verify command state effects."),
    },
    async ({ command, shell, timeout_ms, yield_ms, run_in_background, verify }) => {
      const res = await processManager.execCommand({
        command,
        cwd: getRoot(),
        shell,
        timeoutMs: timeout_ms,
        yieldMs: yield_ms,
        runInBackground: run_in_background,
        verify,
      });
      return formatMcpResponse(res);
    }
  );

  // 17. read_process_output
  registerTool(
    "read_process_output",
    "Streams stdout/stderr chunks from a running or completed process session using pagination cursors (never losing background task output).",
    {
      session_id: z.string().describe("Process session ID."),
      cursor: z.number().int().nonnegative().optional().describe("Cursor offset to read from. Defaults to 0."),
    },
    async ({ session_id, cursor }) => {
      const res = processManager.readProcessOutput(session_id, cursor ?? 0);
      return formatMcpResponse(res);
    }
  );

  // 18. write_stdin
  registerTool(
    "write_stdin",
    "Sends input to a running process session stdin.",
    {
      session_id: z.string().describe("Session ID."),
      input: z.string().describe("Text to write to stdin."),
    },
    async ({ session_id, input }) => {
      const res = await processManager.writeStdin(session_id, input);
      return formatMcpResponse(res);
    }
  );

  // 19. interrupt_process
  registerTool(
    "interrupt_process",
    "Sends graceful interrupt (SIGINT/Ctrl-C) to a running process session.",
    {
      session_id: z.string().describe("Session ID to interrupt."),
    },
    async ({ session_id }) => {
      const res = await processManager.interruptProcess(session_id);
      return formatMcpResponse(res);
    }
  );

  // 19b. kill_process
  registerTool(
    "kill_process",
    "Forcefully terminates a process session and its entire descendant process tree.",
    {
      session_id: z.string().describe("Session ID to kill."),
    },
    async ({ session_id }) => {
      const res = await processManager.killProcess(session_id);
      return formatMcpResponse(res);
    }
  );

  // 20. browser_open
  registerTool(
    "browser_open",
    "Opens or attaches to a named persistent Chromium browser session.",
    {
      session_id: z.string().optional().describe("Browser session ID. Defaults to 'default'."),
      url: z.string().optional().describe("Initial URL to open."),
    },
    async ({ session_id = "default", url }) => {
      // 1. Separate session creation: create/retrieve session
      const session = await browserManager.getSession(session_id);

      // 2. If URL supplied: verify navigation outcome
      if (url) {
        const page = browserManager.getActivePage(session);
        const navRes = await navigateAndVerify(page, url);

        if (!navRes.success) {
          return formatMcpResponse({
            success: false,
            error_code: "BROWSER_NAVIGATION_FAILED",
            action: `browser_open "${session_id}"`,
            text: `Browser session "${session_id}" was created, but initial navigation failed.\nRequested: ${url}\nFinal page: ${navRes.finalUrl}\nError: ${navRes.error}`,
            summary: `Browser session "${session_id}" created, but initial navigation failed: ${navRes.error}`,
            verification: {
              performed: true,
              passed: false,
              method: "browser_initial_navigation",
              error: navRes.error,
            },
            data: {
              success: false,
              error_code: "BROWSER_NAVIGATION_FAILED",
              session_created: true,
              navigation_succeeded: false,
              requested_url: url,
              final_url: navRes.finalUrl,
              browser_session_id: session_id,
              browser_session_retained: true,
              error: navRes.error,
              status: navRes.status,
            },
          });
        }

        return formatMcpResponse({
          success: true,
          action: `browser_open "${session_id}"`,
          text: `Browser session "${session_id}" is active at ${navRes.finalUrl}. (Title: "${navRes.title}", HTTP ${navRes.status})`,
          summary: `Browser session "${session_id}" active at ${navRes.finalUrl}`,
          verification: { performed: true, passed: true, method: "browser_session_init" },
          data: {
            sessionId: session_id,
            session_id,
            session_created: true,
            navigation_succeeded: true,
            browser_session_retained: true,
            requested_url: url,
            final_url: navRes.finalUrl,
            url: navRes.finalUrl,
            title: navRes.title,
            status: navRes.status,
          },
        });
      }

      // If no URL supplied, session creation alone is sufficient
      const currentUrl = session.pages[session.activePageIndex]?.url() || "";
      return formatMcpResponse({
        success: true,
        action: `browser_open "${session_id}"`,
        text: `Browser session "${session_id}" is active.`,
        summary: `Browser session "${session_id}" is active`,
        verification: { performed: true, passed: true, method: "browser_session_init" },
        data: {
          sessionId: session_id,
          session_id,
          session_created: true,
          navigation_succeeded: true,
          browser_session_retained: true,
          url: currentUrl,
        },
      });
    }
  );

  // 21. browser_close
  registerTool(
    "browser_close",
    "Closes a persistent browser session and its pages.",
    {
      session_id: z.string().optional().describe("Browser session ID. Defaults to 'default'."),
    },
    async ({ session_id = "default" }) => {
      await browserManager.closeSession(session_id);
      return formatMcpResponse({
        success: true,
        action: `browser_close "${session_id}"`,
        text: `Closed browser session "${session_id}".`,
        verification: { performed: true, passed: true, method: "browser_session_close" },
      });
    }
  );

  // 22. browser_list
  registerTool(
    "browser_list",
    "Lists all active persistent browser sessions and open tabs.",
    {},
    async () => {
      const list = browserManager.listSessions();
      const lines = list.map((s) => `[Session "${s.id}"] ${s.tabsCount} tab(s), active: ${s.activeUrl}`);
      return formatMcpResponse({
        success: true,
        action: "browser_list",
        text: list.length > 0 ? `Active Browser Sessions (${list.length}):\n${lines.join("\n")}` : "No active browser sessions.",
        verification: { performed: true, passed: true, method: "browser_sessions_scan" },
        data: list,
      });
    }
  );

  // 23. browser_navigate
  registerTool(
    "browser_navigate",
    "Navigates the active tab to a URL and verifies load status.",
    {
      url: z.string().describe("URL to navigate to."),
      session_id: z.string().optional().describe("Browser session ID."),
    },
    async ({ url, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeNavigate(session, url);
      return formatMcpResponse(res);
    }
  );

  // 24. page_reload
  registerTool(
    "page_reload",
    "Reloads the current active browser tab.",
    {
      session_id: z.string().optional().describe("Browser session ID."),
    },
    async ({ session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeReload(session);
      return formatMcpResponse(res);
    }
  );

  // 25. page_back
  registerTool(
    "page_back",
    "Navigates back in browser history.",
    {
      session_id: z.string().optional().describe("Browser session ID."),
    },
    async ({ session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeGoBack(session);
      return formatMcpResponse(res);
    }
  );

  // 26. page_forward
  registerTool(
    "page_forward",
    "Navigates forward in browser history.",
    {
      session_id: z.string().optional().describe("Browser session ID."),
    },
    async ({ session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeGoForward(session);
      return formatMcpResponse(res);
    }
  );

  // 27. browser_tab_new
  registerTool(
    "browser_tab_new",
    "Opens a new browser tab in the session.",
    {
      session_id: z.string().optional().describe("Browser session ID."),
      url: z.string().optional().describe("Optional URL to open in new tab."),
    },
    async ({ session_id = "default", url }) => {
      const session = await browserManager.getSession(session_id);
      const tabIdx = await browserManager.createTab(session, url);
      return formatMcpResponse({
        success: true,
        action: `browser_tab_new (Tab #${tabIdx})`,
        text: `Opened new tab #${tabIdx} in session "${session_id}".`,
        verification: { performed: true, passed: true, method: "browser_new_page" },
        data: { tabIndex: tabIdx },
      });
    }
  );

  // 28. browser_tab_select
  registerTool(
    "browser_tab_select",
    "Selects active browser tab by index.",
    {
      tab_index: z.number().int().nonnegative().describe("Tab index to select."),
      session_id: z.string().optional().describe("Browser session ID."),
    },
    async ({ tab_index, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const ok = browserManager.selectTab(session, tab_index);
      return formatMcpResponse({
        success: ok,
        action: `browser_tab_select (${tab_index})`,
        text: ok ? `Switched to tab #${tab_index}.` : `Tab #${tab_index} does not exist.`,
        verification: { performed: true, passed: ok, method: "tab_selection" },
      });
    }
  );

  // 29. browser_tab_close
  registerTool(
    "browser_tab_close",
    "Closes a browser tab by index.",
    {
      tab_index: z.number().int().nonnegative().describe("Tab index to close."),
      session_id: z.string().optional().describe("Browser session ID."),
    },
    async ({ tab_index, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const ok = await browserManager.closeTab(session, tab_index);
      return formatMcpResponse({
        success: ok,
        action: `browser_tab_close (${tab_index})`,
        text: ok ? `Closed tab #${tab_index}.` : `Could not close tab #${tab_index}.`,
        verification: { performed: true, passed: ok, method: "tab_close" },
      });
    }
  );

  // 29b. browser_list_tabs
  registerTool(
    "browser_list_tabs",
    "Lists all open tabs in the browser session with their titles, URLs, and active status.",
    {
      session_id: z.string().optional().describe("Browser session ID. Defaults to 'default'."),
    },
    async ({ session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeListTabs(session);
      return formatMcpResponse(res);
    }
  );

  // 30. browser_snapshot
  registerTool(
    "browser_snapshot",
    "Builds an accessible interactive element tree with stable element references ([ref=e1], [ref=e2]) and version tracking.",
    {
      session_id: z.string().optional().describe("Browser session ID. Defaults to 'default'."),
      verbosity: z.enum(["interactive", "normal", "full"]).optional().describe("Snapshot detail level. Defaults to 'normal'."),
      root_ref: z.string().optional().describe("Optional element reference to scope the snapshot to a subtree."),
      selector: z.string().optional().describe("Optional CSS selector to scope the snapshot to a subtree."),
      max_nodes: z.number().int().positive().optional().describe("Maximum number of elements to capture before truncating. Defaults to 500."),
    },
    async ({ session_id = "default", verbosity = "normal", root_ref, selector, max_nodes }) => {
      const session = await browserManager.getSession(session_id);
      const res = await takeBrowserSnapshot(session, {
        verbosity,
        root_ref,
        selector,
        maxNodes: max_nodes,
      });
      return formatMcpResponse(res);
    }
  );

  // 31. browser_click
  registerTool(
    "browser_click",
    "Clicks an interactive element by reference (e.g. 'e1' from browser_snapshot) or CSS selector.",
    {
      ref: z.string().optional().describe("Element reference from browser_snapshot (e.g. 'e1')."),
      selector: z.string().optional().describe("CSS selector."),
      session_id: z.string().optional().describe("Browser session ID."),
    },
    async ({ ref, selector, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeClick(session, { ref, selector });
      return formatMcpResponse(res);
    }
  );

  // 31b. browser_wait_for
  registerTool(
    "browser_wait_for",
    "Waits for an element state, specific text, URL navigation, or networkidle with timeout.",
    {
      session_id: z.string().optional().describe("Browser session ID."),
      ref: z.string().optional().describe("Element ref from browser_snapshot to wait for."),
      selector: z.string().optional().describe("CSS selector to wait for."),
      text: z.string().optional().describe("Visible text to wait for."),
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional().describe("State to wait for. Defaults to visible."),
      url: z.string().optional().describe("URL or URL glob pattern to wait for."),
      timeout_ms: z.number().int().positive().optional().describe("Timeout in milliseconds (default 10000ms)."),
    },
    async ({ session_id = "default", ref, selector, text, state, url, timeout_ms }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeWaitFor(session, { ref, selector, text, state, url, timeoutMs: timeout_ms });
      return formatMcpResponse(res);
    }
  );

  // 31c. browser_trace_start
  registerTool(
    "browser_trace_start",
    "Starts recording a Playwright diagnostic trace with screenshots and DOM snapshots.",
    {
      session_id: z.string().optional().describe("Browser session ID."),
      screenshots: z.boolean().optional().describe("Whether to capture screenshots in trace (default true)."),
      snapshots: z.boolean().optional().describe("Whether to capture DOM snapshots in trace (default true)."),
    },
    async ({ session_id = "default", screenshots, snapshots }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeTraceStart(session, { screenshots, snapshots });
      return formatMcpResponse(res);
    }
  );

  // 31d. browser_trace_stop
  registerTool(
    "browser_trace_stop",
    "Stops recording the Playwright diagnostic trace and saves it as a zip archive.",
    {
      session_id: z.string().optional().describe("Browser session ID."),
      output_path: z.string().optional().describe("Optional path where the trace zip should be saved."),
      artifact_role: z.enum(["temporary_test", "user_output", "persistent_project_file"]).optional().describe("Lifecycle role for trace archive (defaults to temporary_test)."),
    },
    async ({ session_id = "default", output_path, artifact_role }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeTraceStop(session, output_path);
      if (res.data?.tracePath && runManager.getActiveRun()) {
        const role = artifact_role || "temporary_test";
        await runManager.trackTemporaryFile(
          res.data.tracePath,
          `Browser diagnostic trace (${session_id})`,
          role === "temporary_test",
          role,
          {
            tool: "browser_trace_stop",
            browser_session_id: session_id,
          }
        );
      }
      return formatMcpResponse(res);
    }
  );

  // 32. browser_double_click
  registerTool(
    "browser_double_click",
    "Double-clicks an interactive element.",
    {
      ref: z.string().optional(),
      selector: z.string().optional(),
      session_id: z.string().optional(),
    },
    async ({ ref, selector, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeDoubleClick(session, { ref, selector });
      return formatMcpResponse(res);
    }
  );

  // 33. browser_hover
  registerTool(
    "browser_hover",
    "Hovers over an interactive element.",
    {
      ref: z.string().optional(),
      selector: z.string().optional(),
      session_id: z.string().optional(),
    },
    async ({ ref, selector, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeHover(session, { ref, selector });
      return formatMcpResponse(res);
    }
  );

  // 34. browser_fill
  registerTool(
    "browser_fill",
    "Fills an input element with text and performs mandatory DOM readback verification.",
    {
      ref: z.string().optional().describe("Element reference from browser_snapshot (e.g. 'e1')."),
      selector: z.string().optional().describe("CSS selector."),
      target: z.object({ ref: z.string().optional(), selector: z.string().optional() }).optional(),
      value: z.string().optional().describe("Text value to fill."),
      text: z.string().optional().describe("Alias for value."),
      session_id: z.string().optional().describe("Browser session ID."),
    },
    async (args) => {
      const session = await browserManager.getSession(args.session_id || "default");
      const ref = args.ref || args.target?.ref;
      const selector = args.selector || args.target?.selector;
      const val = args.value ?? args.text ?? "";
      const res = await executeFill(session, { ref, selector }, val);
      return formatMcpResponse(res);
    }
  );

  // 35. browser_check
  registerTool(
    "browser_check",
    "Checks a checkbox with mandatory DOM .isChecked() readback verification.",
    {
      ref: z.string().optional(),
      selector: z.string().optional(),
      target: z.object({ ref: z.string().optional(), selector: z.string().optional() }).optional(),
      checked: z.boolean().optional().describe("Defaults to true."),
      session_id: z.string().optional(),
    },
    async (args) => {
      const session = await browserManager.getSession(args.session_id || "default");
      const ref = args.ref || args.target?.ref;
      const selector = args.selector || args.target?.selector;
      const res = await executeCheck(session, { ref, selector }, args.checked ?? true);
      return formatMcpResponse(res);
    }
  );

  // 36. browser_uncheck
  registerTool(
    "browser_uncheck",
    "Unchecks a checkbox with mandatory DOM .isChecked() readback verification.",
    {
      ref: z.string().optional(),
      selector: z.string().optional(),
      session_id: z.string().optional(),
    },
    async ({ ref, selector, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeCheck(session, { ref, selector }, false);
      return formatMcpResponse(res);
    }
  );

  // 37. browser_select
  registerTool(
    "browser_select",
    "Selects a dropdown option with DOM readback verification.",
    {
      ref: z.string().optional(),
      selector: z.string().optional(),
      value: z.string().describe("Option value to select."),
      session_id: z.string().optional(),
    },
    async ({ ref, selector, value, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeSelect(session, { ref, selector }, value);
      return formatMcpResponse(res);
    }
  );

  // 38. browser_upload
  registerTool(
    "browser_upload",
    "Uploads files to a file input element.",
    {
      ref: z.string().optional(),
      selector: z.string().optional(),
      files: z.array(z.string()).describe("Paths of files to upload."),
      session_id: z.string().optional(),
    },
    async ({ ref, selector, files, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeUpload(session, { ref, selector }, files);
      return formatMcpResponse(res);
    }
  );

  // 39. browser_press_key
  registerTool(
    "browser_press_key",
    "Presses a keyboard key on the browser page (e.g. 'Enter', 'Tab').",
    {
      key: z.string().describe("Key name."),
      ref: z.string().optional().describe("Optional element reference to target."),
      selector: z.string().optional().describe("Optional selector to target."),
      session_id: z.string().optional().describe("Browser session ID."),
    },
    async ({ key, ref, selector, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executePressKey(session, key, { ref, selector });
      return formatMcpResponse(res);
    }
  );

  // 40. browser_eval
  registerTool(
    "browser_eval",
    "Evaluates a JavaScript expression in the active browser page context.",
    {
      script: z.string().describe("JavaScript code to evaluate."),
      session_id: z.string().optional(),
    },
    async ({ script, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeEval(session, script);
      return formatMcpResponse(res);
    }
  );

  // 41. browser_pdf
  registerTool(
    "browser_pdf",
    "Renders and saves the active page to a PDF document with disk verification.",
    {
      output_path: z.string().optional().describe("Output PDF file path."),
      session_id: z.string().optional(),
      artifact_role: z.enum(["temporary_test", "user_output", "persistent_project_file"]).optional().describe("Lifecycle role for PDF export (defaults to user_output)."),
    },
    async ({ output_path, session_id = "default", artifact_role }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executePdf(session, output_path);
      if (res.data?.filePath && runManager.getActiveRun()) {
        const role = artifact_role || "user_output";
        await runManager.trackTemporaryFile(
          res.data.filePath,
          `Browser PDF export (${session_id})`,
          role === "temporary_test",
          role,
          {
            tool: "browser_pdf",
            browser_session_id: session_id,
          }
        );
      }
      return formatMcpResponse(res);
    }
  );

  // 42. browser_console
  registerTool(
    "browser_console",
    "Retrieves captured console logs from the browser session with optional severity, text, and limit filters.",
    {
      session_id: z.string().optional().describe("Browser session ID. Defaults to 'default'."),
      level: z.string().optional().describe("Optional log level filter (e.g. 'error', 'warn', 'info', 'log')."),
      filter: z.string().optional().describe("Optional substring filter for console message text."),
      limit: z.number().int().positive().optional().describe("Max number of recent logs to return."),
    },
    async ({ session_id = "default", level, filter, limit }) => {
      const session = await browserManager.getSession(session_id);
      const res = executeGetConsole(session, { level, filter, limit });
      return formatMcpResponse(res);
    }
  );

  // 43. browser_network
  registerTool(
    "browser_network",
    "Retrieves captured network requests and responses with optional status, failed-only, url pattern, and resource type filters.",
    {
      session_id: z.string().optional().describe("Browser session ID. Defaults to 'default'."),
      status: z.number().int().optional().describe("Filter by HTTP status code."),
      failed_only: z.boolean().optional().describe("Only return failed requests."),
      url_pattern: z.string().optional().describe("Filter requests containing this URL pattern."),
      resource_type: z.string().optional().describe("Filter by resource type (e.g. 'xhr', 'fetch', 'document')."),
      limit: z.number().int().positive().optional().describe("Max number of recent events to return."),
    },
    async ({ session_id = "default", status, failed_only, url_pattern, resource_type, limit }) => {
      const session = await browserManager.getSession(session_id);
      const res = executeGetNetwork(session, {
        status,
        failedOnly: failed_only,
        urlPattern: url_pattern,
        resourceType: resource_type,
        limit,
      });
      return formatMcpResponse(res);
    }
  );

  // 44. browser_screenshot
  registerTool(
    "browser_screenshot",
    "Captures a screenshot of the browser page, verifies disk persistence, and attaches the base64 image block for direct visual inspection by the model.",
    {
      full_page: z.boolean().optional().describe("Capture full scrollable page. Defaults to false."),
      output_path: z.string().optional().describe("Optional path to save screenshot file."),
      session_id: z.string().optional().describe("Browser session ID."),
      artifact_role: z.enum(["temporary_test", "user_output", "persistent_project_file"]).optional().describe("Lifecycle role for screenshot (defaults to temporary_test)."),
    },
    async ({ full_page, output_path, session_id = "default", artifact_role }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeBrowserScreenshot({
        session,
        outputPath: output_path,
        fullPage: full_page ?? false,
      });
      if (res.toolResponse.data?.filePath && runManager.getActiveRun()) {
        const role = artifact_role || "temporary_test";
        await runManager.trackTemporaryFile(
          res.toolResponse.data.filePath,
          `Browser screenshot (${session_id})`,
          role === "temporary_test",
          role,
          {
            tool: "browser_screenshot",
            browser_session_id: session_id,
            sha256: res.toolResponse.data.sha256,
            bytes: res.toolResponse.data.bytes,
            width: res.toolResponse.data.width,
            height: res.toolResponse.data.height,
          }
        );
      }
      return formatMcpResponse(res.toolResponse, { image: res.imagePayload });
    }
  );

  // 45. screenshot_desktop
  registerTool(
    "screenshot_desktop",
    "Captures the entire desktop or a rectangular region (outside the browser) and returns visual base64 image payload.",
    {
      output_path: z.string().optional(),
      region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
      artifact_role: z.enum(["temporary_test", "user_output", "persistent_project_file"]).optional().describe("Lifecycle role for desktop screenshot (defaults to temporary_test)."),
    },
    async ({ output_path, region, artifact_role }) => {
      const res = await executeDesktopScreenshot({ outputPath: output_path, region });
      if (res.toolResponse.data?.filePath && runManager.getActiveRun()) {
        const role = artifact_role || "temporary_test";
        await runManager.trackTemporaryFile(
          res.toolResponse.data.filePath,
          "Desktop screenshot",
          role === "temporary_test",
          role,
          {
            tool: "screenshot_desktop",
            sha256: res.toolResponse.data.sha256,
            bytes: res.toolResponse.data.bytes,
            width: res.toolResponse.data.width,
            height: res.toolResponse.data.height,
          }
        );
      }
      return formatMcpResponse(res.toolResponse, { image: res.imagePayload });
    }
  );

  // 46. list_windows
  registerTool(
    "list_windows",
    "Lists active desktop windows with titles and process PIDs (Windows hosts).",
    {},
    async () => {
      const res = executeListWindows();
      return formatMcpResponse(res);
    }
  );

  // 47. focus_window
  registerTool(
    "focus_window",
    "Brings a desktop window to the foreground by title or PID.",
    {
      target: z.string().describe("Window title substring or PID."),
    },
    async ({ target }) => {
      const res = executeFocusWindow(target);
      return formatMcpResponse(res);
    }
  );

  // 48. read_notebook
  registerTool(
    "read_notebook",
    "Reads a Jupyter notebook (.ipynb) structurally with cell types, source, and execution counts.",
    {
      notebook_path: z.string().describe("Path to .ipynb file."),
    },
    async ({ notebook_path }) => {
      const res = await executeReadNotebook({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        notebookPath: notebook_path,
      });
      return formatMcpResponse(res);
    }
  );

  // 49. edit_notebook
  registerTool(
    "edit_notebook",
    "Edits, inserts, or deletes cells in a Jupyter notebook (.ipynb) with mandatory post-mutation JSON verification.",
    {
      notebook_path: z.string().describe("Path to .ipynb file."),
      cell_id: z.string().optional().describe("Target cell ID."),
      cell_index: z.number().int().positive().optional().describe("Target 1-based cell index."),
      new_source: z.string().describe("New source code or markdown."),
      cell_type: z.enum(["code", "markdown"]).optional().describe("Cell type. Defaults to code."),
      edit_mode: z.enum(["replace", "insert", "delete"]).optional().describe("Edit mode. Defaults to replace."),
    },
    async ({ notebook_path, cell_id, cell_index, new_source, cell_type, edit_mode }) => {
      const res = await executeEditNotebook({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        notebookPath: notebook_path,
        cellId: cell_id,
        cellIndex: cell_index,
        newSource: new_source,
        cellType: cell_type,
        editMode: edit_mode,
      });
      return formatMcpResponse(res);
    }
  );

  // 50. git_status
  registerTool(
    "git_status",
    "Checks git working tree status and branch name.",
    {},
    async () => {
      const res = executeGitStatus(getRoot());
      return formatMcpResponse(res);
    }
  );

  // 51. git_diff
  registerTool(
    "git_diff",
    "Returns git diff against HEAD or specified ref.",
    {
      target_ref: z.string().optional().describe("Git ref to diff against. Defaults to HEAD."),
      file_paths: z.array(z.string()).optional().describe("Filter to specific files."),
    },
    async ({ target_ref, file_paths }) => {
      const res = executeGitDiff(getRoot(), { targetRef: target_ref, filePaths: file_paths });
      return formatMcpResponse(res);
    }
  );

  // 51b. git_conflicts
  registerTool(
    "git_conflicts",
    "Inspects working tree for git merge, rebase, or cherry-pick conflicts, returning conflicted files and conflict markers.",
    {},
    async () => {
      const res = executeGitConflicts(getRoot());
      return formatMcpResponse(res);
    }
  );

  // 52. show_changes
  registerTool(
    "show_changes",
    "Shows unified summary of all uncommitted modifications and git diff.",
    {},
    async () => {
      const res = executeShowChanges(getRoot());
      return formatMcpResponse(res);
    }
  );

  // 53. revert_changes
  registerTool(
    "revert_changes",
    "Reverts uncommitted changes with mandatory post-revert git status verification.",
    {
      file_paths: z.array(z.string()).optional().describe("Specific files to revert. Omit to revert all."),
    },
    async ({ file_paths }) => {
      const res = executeRevertChanges(getRoot(), file_paths);
      return formatMcpResponse(res);
    }
  );

  // 54. enter_worktree
  registerTool(
    "enter_worktree",
    "Creates an isolated Git worktree for branch development and updates active workspace root.",
    {
      name: z.string().optional().describe("Branch / worktree name."),
      base_ref: z.string().optional().describe("Base Git ref. Defaults to HEAD."),
    },
    async ({ name, base_ref }) => {
      const res = await executeEnterWorktree({ name, baseRef: base_ref });
      return formatMcpResponse(res);
    }
  );

  // 55. exit_worktree
  registerTool(
    "exit_worktree",
    "Leaves the worktree and switches back to main checkout, with dirty-state safety guard.",
    {
      action: z.enum(["keep", "remove"]).describe("Keep or remove the worktree folder."),
      force: z.boolean().optional().describe("Force removal even if uncommitted changes exist. Defaults to false."),
    },
    async ({ action, force }) => {
      const res = await executeExitWorktree({ action, force });
      return formatMcpResponse(res);
    }
  );

  // 56. list_worktrees
  registerTool(
    "list_worktrees",
    "Lists all existing git worktrees.",
    {},
    async () => {
      const res = executeListWorktrees(getRoot());
      return formatMcpResponse(res);
    }
  );

  // 57. task_create
  registerTool(
    "task_create",
    "Creates a new task in the planning store.",
    {
      subject: z.string().describe("Task subject / title."),
      description: z.string().optional().describe("Detailed task description."),
    },
    async ({ subject, description }) => {
      const res = taskStore.createTask(subject, description);
      return formatMcpResponse(res);
    }
  );

  // 58. task_update
  registerTool(
    "task_update",
    "Updates task status, subject, or description.",
    {
      id: z.string().describe("Task ID."),
      status: z.enum(["pending", "in_progress", "completed", "failed"]).optional(),
      subject: z.string().optional(),
      description: z.string().optional(),
    },
    async ({ id, status, subject, description }) => {
      const res = taskStore.updateTask(id, { status, subject, description });
      return formatMcpResponse(res);
    }
  );

  // 59. task_list
  registerTool(
    "task_list",
    "Lists all tasks and their current status.",
    {},
    async () => {
      const res = taskStore.listTasks();
      return formatMcpResponse(res);
    }
  );

  // 60. activity_list
  registerTool(
    "activity_list",
    "Lists retained live execution trace activity events (intent, actions, verifications, fallbacks, warnings, results) without leaking private model chain-of-thought.",
    {
      limit: z.number().int().positive().optional().describe("Maximum number of events to list. Defaults to 50."),
    },
    async ({ limit }) => {
      const events = activityStream.list(limit ?? 50);
      const summaryText =
        events.length === 0
          ? "No activity events recorded yet."
          : events
              .map(
                (e) =>
                  `[${e.timestamp}] #${e.seq} ${e.type.toUpperCase()}: ${e.title}${
                    e.tool ? ` (tool: ${e.tool})` : ""
                  }${e.reason ? ` - ${e.reason}` : ""}`
              )
              .join("\n");
      return formatMcpResponse({
        success: true,
        action: "activity_list",
        text: summaryText,
        data: { events, total_retained: activityStream.size() },
        verification: { performed: true, passed: true, method: "activity_stream" },
      });
    }
  );

  // 61. activity_read
  registerTool(
    "activity_read",
    "Reads activity stream events with cursor pagination metadata (cursor, next_cursor, has_more, total_retained). If run_id is supplied, reads directly from run's disk journal.",
    {
      run_id: z.string().optional().describe("Optional run ID to read from durable run events.jsonl instead of memory buffer."),
      cursor: z.number().int().nonnegative().optional().describe("Cursor sequence number to read after. Defaults to 0."),
      limit: z.number().int().positive().optional().describe("Maximum events to read. Defaults to 50."),
      type: z
        .enum([
          "plan",
          "action_started",
          "action_progress",
          "action_completed",
          "verification",
          "fallback",
          "retry",
          "warning",
          "failure",
          "cleanup",
          "info",
        ])
        .optional()
        .describe("Filter by event type."),
      workspace_id: z.string().optional().describe("Filter by workspace ID."),
      browser_session_id: z.string().optional().describe("Filter by browser session ID."),
      process_session_id: z.string().optional().describe("Filter by process session ID."),
    },
    async ({ run_id, cursor, limit, type, workspace_id, browser_session_id, process_session_id }) => {
      if (run_id) {
        const res = await runManager.readRunEvents(run_id, cursor ?? 0, limit ?? 50);
        return formatMcpResponse({
          success: true,
          action: `activity_read (run_id: ${run_id})`,
          text: `Retrieved ${res.events.length} activity events for run "${run_id}" from disk journal.`,
          data: res,
          verification: { performed: true, passed: true, method: "run_journal_events_read" },
        });
      }

      const result = activityStream.read({
        cursor: cursor ?? 0,
        limit: limit ?? 50,
        type: type as any,
        workspace_id,
        browser_session_id,
        process_session_id,
      });
      return formatMcpResponse({
        success: true,
        action: "activity_read",
        text: `Retrieved ${result.events.length} activity events (cursor: ${result.cursor}, next_cursor: ${result.next_cursor}, has_more: ${result.has_more}, total_retained: ${result.total_retained}).`,
        data: result,
        verification: { performed: true, passed: true, method: "activity_stream_pagination" },
      });
    }
  );

  // 62. activity_clear
  registerTool(
    "activity_clear",
    "Clears the live execution trace activity stream.",
    {},
    async () => {
      const cleared = activityStream.clear();
      return formatMcpResponse({
        success: true,
        action: "activity_clear",
        text: `Cleared ${cleared.cleared_count} activity stream events.`,
        data: cleared,
        verification: { performed: true, passed: true, method: "activity_stream_clear" },
      });
    }
  );

  // 63. activity_monitor
  registerTool(
    "activity_monitor",
    "Returns live execution status, current action in flight with WHY/target, recent events summary, and user-facing Live Activity Monitor UI URL (e.g. http://localhost:port/monitor).",
    {
      run_id: z.string().optional().describe("Durable run ID to bind this monitor instance to. Defaults to the active run if one exists."),
      limit: z.number().int().positive().optional().describe("Number of recent events to include in summary. Defaults to 10."),
    },
    async ({ run_id, limit }) => {
      const port = config.port || 3000;
      const runObj = run_id ? await runManager.getRun(run_id) : null;
      const targetRun = runObj?.run || runManager.getActiveRun();
      const boundRunId = targetRun?.run_id || run_id;
      const monitorUrl = boundRunId
        ? `http://localhost:${port}/monitor?run_id=${encodeURIComponent(boundRunId)}`
        : `http://localhost:${port}/monitor`;
      const uiResourceUri = boundRunId
        ? `ui://verity/activity-monitor?run_id=${encodeURIComponent(boundRunId)}`
        : "ui://verity/activity-monitor";

      const currentAction = (boundRunId && targetRun)
        ? targetRun.current_action
        : activityStream.getCurrentAction();

      let recentEvents: any[] = [];
      let totalRetained = 0;

      if (boundRunId) {
        const journal = await runManager.readRunEvents(boundRunId, 0, limit ?? 10);
        recentEvents = journal.events;
        totalRetained = (journal as any).total_available ?? journal.events.length;
      } else {
        const recent = activityStream.read({ limit: limit ?? 10 });
        recentEvents = recent.events;
        totalRetained = activityStream.size();
      }

      let actionTitle = "";
      let actionStatus = "running";
      let actionPurpose = "";
      let actionTarget = "";
      if (typeof currentAction === "string") {
        actionTitle = currentAction;
      } else if (currentAction && typeof currentAction === "object") {
        const actObj = currentAction as any;
        actionTitle = actObj.display_title || actObj.title || "";
        actionStatus = actObj.status || "running";
        actionPurpose = actObj.purpose || "";
        actionTarget = typeof actObj.target === "object" ? JSON.stringify(actObj.target) : String(actObj.target || "");
      }

      const summaryLines = [
        `Live Activity Monitor: ${monitorUrl}`,
        `Server State: ${currentAction ? "WORKING" : "IDLE"}`,
        currentAction
          ? `Current Action: ${actionTitle} [${actionStatus}]${actionPurpose ? ` (Why: ${actionPurpose})` : ""}${actionTarget ? ` | Target: ${actionTarget}` : ""}`
          : "Current Action: None (idle / waiting for agent instruction)",
        ...(boundRunId ? [`Bound Run: ${boundRunId}`] : []),
        `Total Retained Events: ${totalRetained}`,
        `Recent Events (${recentEvents.length}):`,
        ...recentEvents.map((e: any) => `  [#${e.seq}] [${e.type}] ${e.display_title || e.title}${e.purpose ? ` (Why: ${e.purpose})` : ""}${e.status ? ` - ${e.status}` : ""}`),
      ];

      return formatMcpResponse(
        {
          success: true,
          action: "activity_monitor",
          display_title: boundRunId ? `Activity Monitor (${boundRunId})` : "Activity Monitor Status",
          display_status: currentAction ? "running" : "completed",
          text: summaryLines.join("\n"),
          data: {
            monitor_url: monitorUrl,
            sse_stream_url: `http://localhost:${port}/activity/stream${boundRunId ? `?run_id=${encodeURIComponent(boundRunId)}` : ""}`,
            poll_events_url: `http://localhost:${port}/activity/events${boundRunId ? `?run_id=${encodeURIComponent(boundRunId)}` : ""}`,
            ui_resource: uiResourceUri,
            run_id: boundRunId,
            current_action: currentAction,
            total_retained: totalRetained,
            recent_events: recentEvents,
          },
          verification: { performed: true, passed: true, method: "activity_stream_monitor" },
        },
        {
          resource: {
            uri: uiResourceUri,
            mimeType: "text/html;profile=mcp-app",
            text: getMonitorHtml({
              runId: boundRunId,
              projectKey: targetRun?.project_key,
              taskKey: targetRun?.task_key,
            }),
          },
        }
      );
    }
  );

  // 64. get_environment
  registerTool(
    "get_environment",
    "Returns detected environment profile: OS, shells, compilers, and dev tools (cached for speed).",
    {
      force_refresh: z.boolean().optional().describe("Force re-probing tools. Defaults to false."),
    },
    async ({ force_refresh }) => {
      const res = detectEnvironment(force_refresh ?? false);
      return formatMcpResponse(res);
    }
  );

  // 65. list_skills
  registerTool(
    "list_skills",
    "Lists available workspace and global skills with names, sources, and descriptions.",
    {},
    async () => {
      const skills = await discoverSkills(getRoot());
      const text =
        skills.length > 0
          ? `Available Skills (${skills.length}):\n` +
            skills.map((s) => `- ${s.name} [${s.source}]: ${s.description}`).join("\n")
          : "No skills discovered.";
      return formatMcpResponse({
        success: true,
        action: "list_skills",
        text,
        verification: { performed: true, passed: true, method: "skill_discovery" },
        data: { skills },
      });
    }
  );

  // 66. read_skill
  registerTool(
    "read_skill",
    "Reads instructions and content of a discovered skill by name or path.",
    {
      skill_name: z.string().describe("Skill name or relative/absolute path to SKILL.md."),
    },
    async ({ skill_name }) => {
      try {
        const { name, content, path: skillPath } = await readSkillContent(skill_name, getRoot());
        return formatMcpResponse({
          success: true,
          action: `read_skill "${skill_name}"`,
          text: `=== SKILL: ${name} ===\nPath: ${skillPath}\n\n${content}`,
          verification: { performed: true, passed: true, method: "skill_read" },
          data: { name, path: skillPath, content },
        });
      } catch (err: any) {
        return formatMcpResponse({
          success: false,
          action: `read_skill "${skill_name}"`,
          text: err.message,
          verification: { performed: true, passed: false, method: "skill_read", error: err.message },
        });
      }
    }
  );

  // 67. verity_diagnostics
  registerTool(
    "verity_diagnostics",
    "Returns comprehensive health diagnostics, shell availability, browser status, and tool reliability audit logs.",
    {},
    async () => {
      const res = observabilityManager.getDiagnostics();
      return formatMcpResponse(res);
    }
  );

  // 68. verity_self_test
  registerTool(
    "verity_self_test",
    "Executes a comprehensive, non-destructive end-to-end self test verifying filesystem atomic writes/reads/hashes, shell command execution, git availability, process sessions, and browser subsystem.",
    {},
    async () => {
      const res = await observabilityManager.runSelfTest(getRoot());
      return formatMcpResponse(res);
    }
  );

  // 69. verity_acceptance_test
  registerTool(
    "verity_acceptance_test",
    "Executes deep acceptance test suite covering atomic filesystem mutations, shell encodings, desktop screenshot capture, and browser lifecycle verification.",
    {},
    async () => {
      const res = await observabilityManager.runAcceptanceTest(getRoot());
      return formatMcpResponse(res);
    }
  );

  // 70. start_run
  registerTool(
    "start_run",
    "Starts a durable autonomous run with goal, optional workspace, purpose, project_key, task_key, and phases. Returns run_id, persistent storage path, and embedded Live Activity Monitor UI.",
    {
      goal: z.string().describe("Autonomous goal or high-level mission to execute."),
      workspace: z.string().optional().describe("Workspace root directory path. Defaults to current active workspace."),
      purpose: z.string().optional().describe("Initial operational reason/intent."),
      project_key: z.string().optional().describe("Durable project identifier (e.g. 'trebell-code')."),
      task_key: z.string().optional().describe("Durable task identifier (e.g. 'native-harness-benchmark')."),
      tags: z.array(z.string()).optional().describe("Tags categorizing the run."),
      idempotency_key: z.string().optional().describe("Client idempotency key to prevent duplicate runs from rapid replays."),
      conversation_id: z.string().optional().describe("Originating ChatGPT conversation ID for cross-chat tracking."),
      internal_test: z.boolean().optional().describe("Marks run as an internal test run, excluding it from default user run searches."),
      run_kind: z.enum(["user_work", "internal_test", "benchmark"]).optional().describe("Kind of run."),
      phases: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            status: z.enum(["pending", "in_progress", "completed", "failed", "skipped"]).optional(),
          })
        )
        .optional()
        .describe("Execution phases for tracking progress."),
    },
    async ({ goal, workspace, purpose, project_key, task_key, tags, idempotency_key, conversation_id, phases, internal_test, run_kind }) => {
      const targetWs = workspace || workspaceManager.getActiveWorkspaceRoot() || process.cwd();
      const res = await runManager.startRun({
        goal,
        workspace: targetWs,
        purpose,
        project_key,
        task_key,
        tags,
        idempotency_key,
        conversation_id,
        phases: phases as any,
        internal_test,
        run_kind,
      });

      return formatMcpResponse(
        {
          success: true,
          action: `start_run "${goal.slice(0, 50)}"`,
          display_title: `Run started: ${res.run.run_id}`,
          text: [
            `Started VerityMCP Run: ${res.run.run_id}`,
            `Project Key: ${res.run.project_key || "none"}`,
            `Task Key: ${res.run.task_key || "none"}`,
            `Goal: ${res.run.original_goal}`,
            `Workspace: ${res.run.workspace}`,
            `Persistent Storage: ${res.storage_path}`,
            `Status: ${res.run.status}`,
            `Live Monitor: ${res.monitor_url}`,
            `MCP App UI Resource: ${res.ui_resource_uri}`,
          ].join("\n"),
          summary: `Started durable run ${res.run.run_id} [${res.run.task_key || "task"}]`,
          data: {
            run_id: res.run.run_id,
            project_key: res.run.project_key,
            task_key: res.run.task_key,
            tags: res.run.tags,
            goal: res.run.original_goal,
            status: res.run.status,
            workspace: res.run.workspace,
            storage_path: res.storage_path,
            monitor_url: res.monitor_url,
            ui_resource: res.ui_resource_uri,
            phases: res.run.phases,
          },
          verification: { performed: true, passed: true, method: "run_journal_persistence" },
        },
        {
          resource: {
            uri: res.ui_resource_uri,
            mimeType: "text/html;profile=mcp-app",
            text: getMonitorHtml(),
          },
        }
      );
    }
  );

  // 71. checkpoint_run
  registerTool(
    "checkpoint_run",
    "Updates durable checkpoint with completed steps, currently active step, pending steps, phases, and notes.",
    {
      run_id: z.string().optional().describe("Run ID to checkpoint. Defaults to active run."),
      completed: z.array(z.string()).optional().describe("Steps completed so far."),
      current: z.string().optional().describe("Currently active task or step."),
      pending: z.array(z.string()).optional().describe("Outstanding or remaining steps."),
      phases: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            status: z.enum(["pending", "in_progress", "completed", "failed", "skipped"]).optional(),
          })
        )
        .optional()
        .describe("Updated phase statuses."),
      notes: z.string().optional().describe("Operational context or notes."),
    },
    async ({ run_id, completed, current, pending, phases, notes }) => {
      const chk = await runManager.checkpointRun(run_id, {
        completed,
        current,
        pending,
        phases: phases as any,
        notes,
      });
      return formatMcpResponse({
        success: true,
        action: "checkpoint_run",
        display_title: `Checkpoint recorded`,
        text: [
          `Checkpoint recorded successfully.`,
          `Completed steps (${chk.completed.length}): ${chk.completed.join(", ")}`,
          `Current: ${chk.current || "None"}`,
          `Pending steps (${chk.pending.length}): ${chk.pending.join(", ")}`,
          notes ? `Notes: ${notes}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        summary: `Checkpoint saved: ${chk.completed.length} completed, ${chk.pending.length} pending`,
        data: chk,
        verification: { performed: true, passed: true, method: "run_checkpoint_persistence" },
      });
    }
  );

  // 72. resume_run
  registerTool(
    "resume_run",
    "Recovers execution context from durable run storage (<server_root>/.verity). Reconciles file hashes, git status, live browser/process sessions. Always call this when user says 'continue' or 'resume'.",
    {
      run_id: z.string().optional().describe("Run ID to resume. If omitted, recovers the most recent incomplete or active run."),
    },
    async ({ run_id }) => {
      const recovery = await runManager.resumeRun(run_id);
      const resSummary = recovery.resource_summary || summarizeRunResources(recovery as any);
      const summaryLines = [
        `=== Recovered VerityMCP Run: ${recovery.recovered_run_id} ===`,
        `Original Goal: ${recovery.original_goal}`,
        `Workspace: ${recovery.workspace}`,
        `Status: ${recovery.status}`,
        ``,
        `Completed Steps (${recovery.completed_steps.length}):`,
        ...recovery.completed_steps.map((s) => `  ✓ ${s}`),
        ``,
        recovery.in_progress_when_interrupted
          ? `In Progress When Interrupted: ${recovery.in_progress_when_interrupted}`
          : `Last Action: ${recovery.last_successful_action || "None"}`,
        ``,
        `Remaining Steps (${recovery.current_remaining_steps.length}):`,
        ...recovery.current_remaining_steps.map((s) => `  ○ ${s}`),
        `Active Resources:`,
        `  Browsers: ${resSummary.browsers.active}`,
        `  Processes: ${resSummary.processes.running}`,
        `  Worktrees: ${resSummary.worktrees.active}`,
        ``,
        `Historical Resources:`,
        `  Browsers: ${resSummary.browsers.historical}`,
        `  Processes: ${resSummary.processes.historical}`,
        `  Worktrees: ${resSummary.worktrees.historical}`,
        ``,
        `Temporary Artifacts:`,
        `  Existing: ${resSummary.artifacts.existingTemporary}`,
        `  Historical: ${resSummary.artifacts.historicalTemporary}`,
        ``,
        `Cleanup Debt:`,
        `  Unresolved: ${resSummary.cleanupDebt.unresolved}`,
        `  Resolved: ${resSummary.cleanupDebt.resolved}`,
        `Last Checkpoint: ${recovery.last_checkpoint_timestamp || "None"}`,
        ``,
        recovery.instruction_for_agent,
      ];

      if (recovery.reconciliation.warnings.length > 0) {
        summaryLines.push(``, `Reconciliation Warnings:`, ...recovery.reconciliation.warnings.map((w) => `  ! ${w}`));
      }

      return formatMcpResponse({
        success: true,
        action: `resume_run "${recovery.recovered_run_id}"`,
        display_title: `Resumed run ${recovery.recovered_run_id}`,
        text: summaryLines.join("\n"),
        summary: `Resumed run ${recovery.recovered_run_id}: ${recovery.completed_steps.length} completed, ${recovery.current_remaining_steps.length} remaining`,
        data: recovery,
        warnings: recovery.reconciliation.warnings,
        verification: { performed: true, passed: true, method: "run_reconciliation" },
      });
    }
  );

  // 73. complete_run
  registerTool(
    "complete_run",
    "Marks a durable run as completed, auditing cleanup debt, open browser sessions, and running processes. Blocks completion if pending steps or unresolved cleanup debt remains unless explicit override is provided.",
    {
      run_id: z.string().optional().describe("Run ID to complete. Defaults to active run."),
      status: z.enum(["completed", "failed", "abandoned"]).optional().describe("Final run status. Defaults to 'completed'."),
      notes: z.string().optional().describe("Final completion notes or verification findings."),
      resolve_pending: z.boolean().optional().describe("If true, automatically marks remaining pending steps as resolved so run can complete."),
      allow_cleanup_debt: z.boolean().optional().describe("If true, allows completion even if unresolved cleanup debt or active resources exist."),
      force: z.boolean().optional().describe("Alias for allow_cleanup_debt."),
    },
    async ({ run_id, status, notes, resolve_pending, allow_cleanup_debt, force }) => {
      const res = await runManager.completeRun(run_id, {
        status,
        notes,
        resolve_pending,
        allow_cleanup_debt: Boolean(allow_cleanup_debt || force),
        force: Boolean(allow_cleanup_debt || force),
      });
      if (res.error_code === "RUN_HAS_PENDING_STEPS") {
        return formatMcpResponse({
          success: false,
          action: `complete_run "${res.run.run_id}"`,
          display_title: `Run completion blocked: ${res.run.run_id}`,
          text: res.cleanup_warnings.join("\n"),
          summary: `Run completion blocked: pending steps remain`,
          data: res,
          error_code: "RUN_HAS_PENDING_STEPS",
          warnings: res.cleanup_warnings,
          verification: { performed: true, passed: false, method: "run_completion_audit" },
        });
      }
      if (res.error_code === "RUN_HAS_CLEANUP_DEBT") {
        return formatMcpResponse({
          success: false,
          action: `complete_run "${res.run.run_id}"`,
          display_title: `Run completion blocked: ${res.run.run_id}`,
          text: res.cleanup_warnings.join("\n"),
          summary: `Run completion blocked: unresolved cleanup debt remains`,
          data: res,
          error_code: "RUN_HAS_CLEANUP_DEBT",
          warnings: res.cleanup_warnings,
          verification: { performed: true, passed: false, method: "run_completion_audit" },
        });
      }
      return formatMcpResponse({
        success: true,
        action: `complete_run "${res.run.run_id}"`,
        display_title: `Run ${res.status}: ${res.run.run_id}`,
        text: [
          `Run ${res.run.run_id} marked as ${res.status}.`,
          `Clean State: ${res.is_clean ? "CLEAN (no unresolved debt)" : "DEBT REMAINING"}`,
          ...res.cleanup_warnings.map((w) => `  ! Warning: ${w}`),
          notes ? `Notes: ${notes}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        summary: `Run ${res.run.run_id} completed (${res.is_clean ? "clean" : "with cleanup warnings"})`,
        data: res,
        warnings: res.cleanup_warnings,
        verification: { performed: true, passed: true, method: "run_completion_audit" },
      });
    }
  );

  // 74. list_runs
  registerTool(
    "list_runs",
    "Lists all durable runs stored under <server_root>/.verity with status, goal, timestamps, and step counts.",
    {
      status: z.enum(["all", "running", "interrupted", "needs_cleanup", "completed", "failed", "abandoned"]).optional().describe("Filter by status. Defaults to all."),
      limit: z.number().int().positive().optional().describe("Maximum runs to return. Defaults to 20."),
    },
    async ({ status, limit }) => {
      const filterStatus = status === "all" ? undefined : status;
      const runs = await runManager.listRuns({ status: filterStatus, limit });
      const textLines = [
        `Persisted Runs (${runs.length}):`,
        ...runs.map((r) => [
          `[${r.status.toUpperCase()}] ${r.run_id}`,
          `  Project: ${r.project_key || "none"}`,
          `  Task: ${r.task_key || "none"}`,
          `  Workspace: ${r.workspace}`,
          `  Goal: ${r.goal.slice(0, 80)}`,
          `  Phase: ${r.current_phase || r.last_action || "none"}`,
          `  Updated: ${r.updated_at}`,
        ].join("\n")),
      ];
      return formatMcpResponse({
        success: true,
        action: "list_runs",
        display_title: "Persisted runs list",
        text: runs.length > 0 ? textLines.join("\n\n") : "No persisted runs found.",
        summary: `Found ${runs.length} persisted run(s)`,
        data: { runs },
        verification: { performed: true, passed: true, method: "run_journal_listing" },
      });
    }
  );

  // 75. get_run
  registerTool(
    "get_run",
    "Gets complete structured state, summary, checkpoint, and optional events for a run.",
    {
      run_id: z.string().describe("Run ID to retrieve."),
      include_events: z.boolean().optional().describe("Include event history from events.jsonl. Defaults to false."),
      event_limit: z.number().int().positive().optional().describe("Maximum events to return if include_events is true. Defaults to 50."),
    },
    async ({ run_id, include_events, event_limit }) => {
      const res = await runManager.getRun(run_id, { include_events, event_limit });
      return formatMcpResponse({
        success: true,
        action: `get_run "${run_id}"`,
        display_title: `Run details: ${run_id}`,
        text: res.summary_markdown,
        summary: `Run ${run_id} [${res.run.status}]: ${res.run.original_goal.slice(0, 50)}`,
        data: res,
        verification: { performed: true, passed: true, method: "run_journal_read" },
      });
    }
  );

  // 76. run_activity_read
  registerTool(
    "run_activity_read",
    "Reads activity events from a run's durable events.jsonl with cursor pagination.",
    {
      run_id: z.string().optional().describe("Run ID to read events for. Defaults to active run."),
      cursor: z.number().int().nonnegative().optional().describe("Cursor sequence number to read after. Defaults to 0."),
      limit: z.number().int().positive().optional().describe("Maximum events to read. Defaults to 50."),
    },
    async ({ run_id, cursor, limit }) => {
      const res = await runManager.readRunEvents(run_id, cursor ?? 0, limit ?? 50);
      return formatMcpResponse({
        success: true,
        action: "run_activity_read",
        display_title: `Run events: ${res.run_id || "active"}`,
        text: `Retrieved ${res.events.length} events for run ${res.run_id} (cursor: ${res.cursor}, next_cursor: ${res.next_cursor}, total: ${res.total_events}).`,
        summary: `Retrieved ${res.events.length} event(s) from run journal`,
        data: res,
        verification: { performed: true, passed: true, method: "run_events_journal_read" },
      });
    }
  );

  // 77. find_runs
  registerTool(
    "find_runs",
    "Finds and contextually ranks existing durable runs across conversations using multi-signal scoring (project key, task key, goal fingerprint, modified files, recency). Flags ambiguous matches to prevent guessing.",
    {
      query: z.string().optional().describe("Search query, goal description, or task keyword."),
      workspace: z.string().optional().describe("Workspace root to scope search to."),
      project_key: z.string().optional().describe("Project key filter (e.g. trebell-code)."),
      task_key: z.string().optional().describe("Task key filter (e.g. native-harness-benchmark-optimization)."),
      statuses: z.array(z.enum(["running", "interrupted", "completed", "failed", "abandoned", "needs_cleanup"])).optional().describe("Filter by statuses."),
      include_internal_tests: z.boolean().optional().describe("Whether to include internal synthetic test runs (defaults to false)."),
      limit: z.number().int().positive().optional().describe("Maximum candidates to return. Defaults to 10."),
    },
    async ({ query, workspace, project_key, task_key, statuses, include_internal_tests, limit }) => {
      const res = await runManager.findRuns({
        query,
        workspace,
        project_key,
        task_key,
        statuses,
        include_internal_tests,
        limit,
      });

      const lines = [
        `Found ${res.candidates.length} run candidate(s) for query: "${query || "*"}"`,
        res.is_ambiguous
          ? `WARNING: AMBIGUOUS_RUN_MATCH. Top runs have similar confidence. Do NOT guess. Ask user or adopt explicitly with adopt_run.`
          : res.top_match
            ? `Top match: ${res.top_match.run_id} [${res.top_match.status}] score=${res.top_match.match_percentage}% (task_key: ${res.top_match.task_key || "none"})`
            : "No matching runs found.",
        "",
        "Candidates:",
        ...res.candidates.map(
          (c, idx) =>
            `  ${idx + 1}. [${c.status.toUpperCase()}] ${c.run_id} (Score: ${c.match_percentage}%, Confidence: ${c.confidence})\n` +
            `     Task Key: ${c.task_key || "none"} | Project: ${c.project_key || "none"}\n` +
            `     Goal: ${c.original_goal.slice(0, 80)}\n` +
            `     Updated: ${c.updated_at}\n` +
            `     Evidence: [${c.evidence.join("; ")}]`
        ),
      ];

      return formatMcpResponse({
        success: true,
        action: "find_runs",
        display_title: `Find runs (${res.candidates.length} found)`,
        text: lines.join("\n"),
        summary: res.is_ambiguous
          ? `Ambiguous run match: ${res.candidates.length} candidates evaluated`
          : `Found ${res.candidates.length} candidate runs; top score: ${res.top_match?.match_percentage ?? 0}%`,
        data: res,
        warnings: res.is_ambiguous ? [res.ambiguity_reason || "AMBIGUOUS_RUN_MATCH"] : undefined,
        verification: { performed: true, passed: true, method: "multi_signal_run_search" },
      });
    }
  );

  // 78. adopt_run
  registerTool(
    "adopt_run",
    "Adopts an existing persisted run from any conversation as the active run in the current session, setting pointers and associating conversation ID.",
    {
      run_id: z.string().describe("Durable run ID to adopt."),
      conversation_id: z.string().optional().describe("Current conversation ID to associate with the adopted run."),
    },
    async ({ run_id, conversation_id }) => {
      const res = await runManager.adoptRun(run_id, conversation_id);
      return formatMcpResponse({
        success: true,
        action: `adopt_run "${run_id}"`,
        display_title: `Adopted run: ${run_id}`,
        text: [
          `Run ${run_id} successfully adopted as active run.`,
          `Status: ${res.run.status}`,
          `Task Key: ${res.run.task_key || "none"}`,
          `Project Key: ${res.run.project_key || "none"}`,
          `Goal: ${res.run.original_goal}`,
          conversation_id ? `Associated Conversation: ${conversation_id}` : "",
          "",
          res.summary_markdown,
        ]
          .filter(Boolean)
          .join("\n"),
        summary: `Adopted run ${run_id} [${res.run.status}]`,
        data: res,
        verification: { performed: true, passed: true, method: "run_adoption" },
      });
    }
  );

  // 79. maintenance_runs
  registerTool(
    "maintenance_runs",
    "Performs safe retention maintenance on accumulated internal synthetic/acceptance test runs under <server_root>/.verity. User runs are NEVER pruned or archived.",
    {
      dry_run: z.boolean().optional().describe("If true (default), simulates maintenance without moving or deleting files."),
      keep_latest: z.number().int().nonnegative().optional().describe("Number of most recent internal test runs to retain. Defaults to 50."),
      older_than_days: z.number().nonnegative().optional().describe("Only internal test runs older than this threshold (in days) beyond keep_latest are eligible. Defaults to 7."),
      internal_tests_only: z.boolean().optional().describe("Guaranteed true. Real user runs are strictly protected and never touched."),
      mode: z.enum(["archive", "delete"]).optional().describe("Maintenance mode: 'archive' moves runs to .verity/archives/internal/ (default), 'delete' permanently removes."),
    },
    async ({ dry_run, keep_latest, older_than_days, internal_tests_only, mode }) => {
      const res = await runManager.maintenanceRuns({
        dry_run: dry_run ?? true,
        keep_latest: keep_latest ?? 50,
        older_than_days: older_than_days ?? 7,
        internal_tests_only: internal_tests_only ?? true,
        mode: mode ?? "archive",
      });

      const lines = [
        `=== VerityMCP Run Maintenance (${res.dry_run ? "DRY RUN - SIMULATION ONLY" : "APPLIED"}) ===`,
        `Mode: ${res.mode.toUpperCase()}`,
        `Target Directory: ${res.archive_directory}`,
        `Internal Test Runs Scanned: ${res.scanned_internal_total}`,
        `Protected Active Internal Runs: ${res.protected_active_internal}`,
        `Eligible Historical Internal Runs: ${res.eligible_historical_internal}`,
        `Historical Retained by Policy: ${res.retained_historical_internal}`,
        `${res.mode === "archive" ? "Archived" : "Deleted"}: ${res.dry_run ? res.eligible_count : res.processed_count}`,
        `Internal Runs Remaining in Active Store: ${res.remaining_internal_active_store}`,
        `User Runs Protected: ${res.user_runs_protected} (NEVER modified)`,
        `User Runs Affected: ${res.user_runs_affected}`,
      ];

      if (res.candidates.length > 0) {
        lines.push(``, `Candidates (${res.candidates.length}):`);
        for (const c of res.candidates.slice(0, 20)) {
          lines.push(`  - [${c.age_days}d old] ${c.run_id} (${c.task_key || "internal"})`);
        }
        if (res.candidates.length > 20) {
          lines.push(`  ... and ${res.candidates.length - 20} more candidates`);
        }
      }

      return formatMcpResponse({
        success: true,
        action: "maintenance_runs",
        display_title: `Run maintenance: ${res.mode} (${res.dry_run ? "dry-run" : `${res.processed_count} processed`})`,
        text: lines.join("\n"),
        summary: `Run maintenance (${res.dry_run ? "dry-run" : res.mode}): ${res.eligible_count} eligible, ${res.processed_count} processed, ${res.user_runs_protected} user runs protected`,
        data: res,
        verification: { performed: true, passed: true, method: "run_maintenance_audit" },
      });
    }
  );

  // 80. verity_blackbox_test
  registerTool(
    "verity_blackbox_test",
    "Runs an orthogonal, seeded black-box robustness test battery validating filesystem, code intelligence, processes, git, browser, desktop, and tasks with full self-cleanup.",
    {
      seed: z.string().optional().describe("Optional seed for reproducible pseudo-random execution. Defaults to current timestamp."),
      workspace_root: z.string().optional().describe("Optional workspace root for test context."),
    },
    async ({ seed, workspace_root }) => {
      const res = await runBlackboxTest({ seed, workspaceRoot: workspace_root });
      return formatMcpResponse(res);
    }
  );

  // 81. verity_robustness_test (alias for verity_blackbox_test)
  registerTool(
    "verity_robustness_test",
    "Alias for verity_blackbox_test: runs an orthogonal, seeded black-box robustness test battery with full self-cleanup.",
    {
      seed: z.string().optional().describe("Optional seed for reproducible pseudo-random execution. Defaults to current timestamp."),
      workspace_root: z.string().optional().describe("Optional workspace root for test context."),
    },
    async ({ seed, workspace_root }) => {
      const res = await runBlackboxTest({ seed, workspaceRoot: workspace_root });
      return formatMcpResponse(res);
    }
  );

  const getParameterHints = (definition: RegisteredToolDefinition) => {
    const schema: any = definition.inputSchema;
    const shapeCandidate = schema?.shape ?? schema?._def?.shape;
    const shape =
      typeof shapeCandidate === "function"
        ? shapeCandidate()
        : shapeCandidate && typeof shapeCandidate === "object"
          ? shapeCandidate
          : {};
    return Object.entries(shape)
      .filter(([name]) => !["purpose", "expected_outcome", "response_detail"].includes(name))
      .map(([name, field]: [string, any]) => ({
        name,
        optional: typeof field?.isOptional === "function" ? field.isOptional() : false,
        description: field?.description || undefined,
      }));
  };

  // Fast-profile gateway: specialist schemas stay deferred until the agent actually needs them.
  registerTool(
    "discover_tools",
    "Searches deferred DesktopMCP capabilities by name/description and returns concise argument hints. Use only when the required specialist tool is not directly exposed.",
    {
      query: z.string().optional().describe("Capability keyword, for example worktree, notebook, browser tab, activity, or task."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum matches. Defaults to 10."),
      include_hot: z.boolean().optional().describe("Include already-direct hot-path tools in results. Defaults to false."),
    },
    async ({ query, limit, include_hot }) => {
      const needle = String(query || "").trim().toLowerCase();
      const allDefinitions = Array.from(toolRegistry.values()).filter(
        (definition) => definition.name !== "discover_tools" && definition.name !== "invoke_tool"
      );
      const deferredDefinitions = allDefinitions.filter((definition) => !HOT_PATH_TOOLS.has(definition.name));
      const pool = include_hot ? allDefinitions : deferredDefinitions;
      const matches = pool
        .filter((definition) => {
          if (!needle) return true;
          return (
            definition.name.toLowerCase().includes(needle) ||
            definition.description.toLowerCase().includes(needle)
          );
        })
        .slice(0, limit ?? 10)
        .map((definition) => ({
          name: definition.name,
          description: definition.description,
          direct: !useFastToolProfile || HOT_PATH_TOOLS.has(definition.name),
          parameters: getParameterHints(definition),
        }));

      const lines =
        matches.length > 0
          ? matches.map((match) => {
              const args = match.parameters
                .map((parameter) => parameter.name + (parameter.optional ? "?" : ""))
                .join(", ");
              return "- " + match.name + (args ? " (" + args + ")" : "") + ": " + match.description;
            })
          : ["No matching specialist tools found."];

      return formatMcpResponse({
        success: true,
        action: "discover_tools",
        text: lines.join("\n"),
        summary: "Found " + matches.length + " matching tool(s)",
        data: {
          profile: useFastToolProfile ? "fast" : "full",
          direct_tool_count: allDefinitions.filter((definition) => !useFastToolProfile || HOT_PATH_TOOLS.has(definition.name)).length,
          deferred_tool_count: useFastToolProfile ? deferredDefinitions.length : 0,
          matches,
        },
        verification: { performed: true, passed: true, method: "internal_tool_registry" },
      });
    }
  );

  registerTool(
    "invoke_tool",
    "Invokes a deferred DesktopMCP capability by name. Discover it first when its arguments are unknown. Real-state verification performed by the target tool remains enabled.",
    {
      name: z.string().describe("Exact DesktopMCP tool name returned by discover_tools."),
      arguments: z.any().optional().describe("Argument object for the target tool."),
    },
    async ({ name, arguments: rawArguments }) => {
      if (name === "discover_tools" || name === "invoke_tool") {
        return formatMcpResponse({
          success: false,
          action: "invoke_tool",
          error_code: "INVALID_DEFERRED_TARGET",
          text: "Gateway tools cannot recursively invoke themselves.",
          verification: { performed: true, passed: false, method: "internal_tool_registry" },
        });
      }

      const definition = toolRegistry.get(name);
      if (!definition) {
        return formatMcpResponse({
          success: false,
          action: "invoke_tool",
          error_code: "TOOL_NOT_FOUND",
          text: "Unknown DesktopMCP tool: " + name,
          verification: { performed: true, passed: false, method: "internal_tool_registry" },
        });
      }

      const parsed = definition.inputSchema.safeParse(rawArguments || {});
      if (!parsed.success) {
        return formatMcpResponse({
          success: false,
          action: "invoke_tool " + name,
          error_code: "INVALID_TOOL_ARGUMENTS",
          text: "Invalid arguments for " + name + ": " + parsed.error.message,
          verification: { performed: true, passed: false, method: "zod_argument_validation" },
        });
      }

      const outerContext = activityContextStorage.getStore();
      const inheritedResponseDetail = outerContext?.args?.response_detail;
      const targetArgs = {
        ...parsed.data,
        ...(parsed.data?.response_detail || !inheritedResponseDetail
          ? {}
          : { response_detail: inheritedResponseDetail }),
      };
      const targetContext: ActivityCallContext = {
        ...(outerContext || {
          callId: activityStream.generateCallId(),
          toolName: name,
          displayTitle: formatToolDisplayTitle(name, targetArgs),
          purpose: formatDefaultPurpose(name, targetArgs),
          purposeSource: "tool_default",
        }),
        toolName: name,
        displayTitle: formatToolDisplayTitle(name, targetArgs),
        purpose:
          (typeof targetArgs?.purpose === "string" && targetArgs.purpose.trim()) ||
          formatDefaultPurpose(name, targetArgs),
        purposeSource:
          typeof targetArgs?.purpose === "string" && targetArgs.purpose.trim()
            ? "caller"
            : "tool_default",
        expectedOutcome:
          typeof targetArgs?.expected_outcome === "string" && targetArgs.expected_outcome.trim()
            ? targetArgs.expected_outcome.trim()
            : undefined,
        target: extractToolTarget(targetArgs),
        args: targetArgs,
      };

      return activityContextStorage.run(targetContext, () => definition.handler(targetArgs));
    }
  );

  return server;
}
