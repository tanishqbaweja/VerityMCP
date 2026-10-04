import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { DevSpaceConfig } from "../types/index.js";
import { formatMcpResponse, type McpToolResponse } from "./response.js";
import { workspaceManager } from "../workspace/workspace_manager.js";
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
import { processManager } from "../shell/process_manager.js";
import { browserManager } from "../browser/browser_manager.js";
import { takeBrowserSnapshot } from "../browser/snapshot.js";
import {
  executeNavigate,
  executeClick,
  executeFill,
  executeCheck,
  executePressKey,
} from "../browser/actions.js";
import { executeBrowserScreenshot } from "../browser/screenshots.js";
import {
  executeGitStatus,
  executeGitDiff,
  executeShowChanges,
  executeRevertChanges,
} from "../git/git_ops.js";
import { taskStore } from "../tasks/task_store.js";
import { observabilityManager } from "../observability/diagnostics.js";

export function createDevSpace4McpServer(config: DevSpaceConfig): McpServer {
  const server = new McpServer(
    {
      name: "devspace-4.0",
      version: "4.0.0",
    },
    {
      instructions: `You are connected to DevSpace 4.0 on the user's local machine.

DevSpace 4.0 Core Philosophy:
AN AGENT MUST BE ABLE TO TRUST ITS TOOLS.
All filesystem mutations, patch applications, git reverts, process executions, browser interactions, and screenshots are verified against real system state before reporting success.

Available Tool Categories:
1. Workspace: open_workspace
2. Filesystem & Mutations: read_file, write_file, edit_file, apply_patch, delete_file, move_file, copy_file, list_directory, locate_files, file_metadata
3. Code Intelligence: search_code, get_outline
4. Shell & Processes: exec_command, read_process_output, write_stdin, interrupt_process
5. Browser Automation: browser_navigate, browser_snapshot, browser_click, browser_fill, browser_check, browser_press_key, browser_screenshot
6. Git Engine: git_status, git_diff, show_changes, revert_changes
7. Tasks: task_create, task_update, task_list
8. Observability: devspace_diagnostics`,
    }
  );

  const registerTool = (
    name: string,
    description: string,
    shape: Record<string, z.ZodTypeAny> | z.ZodTypeAny,
    handler: (args: any) => Promise<McpToolResponse>
  ) => {
    const inputSchema = (shape instanceof z.ZodType ? shape : z.object(shape)) as any;
    server.registerTool(name, { description, inputSchema } as any, async (args: any): Promise<any> => {
      const startTime = Date.now();
      try {
        const response = await handler(args);
        observabilityManager.logToolEvent({
          toolName: name,
          action: name,
          success: !response.isError,
          durationMs: Date.now() - startTime,
          timestamp: Date.now(),
        });
        return response;
      } catch (err: any) {
        observabilityManager.logToolEvent({
          toolName: name,
          action: name,
          success: false,
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
  };

  // Helper to get active workspace root
  const getRoot = () => workspaceManager.getActiveWorkspaceRoot();

  // 1. open_workspace
  registerTool(
    "open_workspace",
    "Opens a project directory or worktree. Returns architectural repo map, git status/branch, supported shells, package scripts, and discovered skills.",
    {
      path: z.string().optional().describe("Path to project root. Defaults to current directory."),
    },
    async ({ path: targetPath }) => {
      const res = await workspaceManager.openWorkspace(targetPath, config.allowedRoots);
      return formatMcpResponse(res);
    }
  );

  // 2. read_file
  registerTool(
    "read_file",
    "Reads a file with line slicing and SHA-256 hash. If reading an image (.png, .jpg, etc.), automatically includes visual image payload in response.",
    {
      file_path: z.string().describe("Path to the file."),
      line_start: z.number().int().positive().optional().describe("1-based start line."),
      line_end: z.number().int().positive().optional().describe("1-based end line."),
      with_line_numbers: z.boolean().optional().describe("Include line numbers. Defaults to true."),
    },
    async ({ file_path, line_start, line_end, with_line_numbers }) => {
      const res = await executeReadFile({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        filePath: file_path,
        lineStart: line_start,
        lineEnd: line_end,
        withLineNumbers: with_line_numbers ?? true,
      });
      return formatMcpResponse(res.toolResponse, { image: res.imagePayload });
    }
  );

  // 3. write_file
  registerTool(
    "write_file",
    "Writes full content to a file with mandatory post-write byte readback and SHA-256 verification.",
    {
      file_path: z.string().describe("Target file path."),
      content: z.string().describe("File content to write."),
      overwrite: z.boolean().optional().describe("Allow overwriting existing files. Defaults to true."),
    },
    async ({ file_path, content, overwrite }) => {
      const res = await executeWriteFile({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        filePath: file_path,
        content,
        overwrite: overwrite ?? true,
      });
      return formatMcpResponse(res);
    }
  );

  // 4. edit_file
  registerTool(
    "edit_file",
    "Performs exact string replacement with uniqueness verification, unified diff output, and post-mutation hash verification.",
    {
      file_path: z.string().describe("Target file path."),
      old_string: z.string().describe("Exact text to replace."),
      new_string: z.string().describe("Replacement text."),
      replace_all: z.boolean().optional().describe("Replace all occurrences if multiple. Defaults to false."),
    },
    async ({ file_path, old_string, new_string, replace_all }) => {
      const res = await executeEditFile({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        filePath: file_path,
        oldString: old_string,
        newString: new_string,
        replaceAll: replace_all ?? false,
      });
      return formatMcpResponse(res);
    }
  );

  // 5. apply_patch
  registerTool(
    "apply_patch",
    "Applies Codex (*** Begin Patch) or unified diffs across one or multiple files with atomic staging, rollback, and mandatory post-mutation verification (preventing false-success conditions).",
    {
      patch: z.string().describe("The patch string to apply."),
    },
    async ({ patch }) => {
      const res = await executeApplyPatch({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        patch,
      });
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
      recursive: z.boolean().optional().describe("Recursive scan. Defaults to false."),
      max_depth: z.number().int().positive().optional().describe("Max recursion depth. Defaults to 2."),
      show_hidden: z.boolean().optional().describe("Include hidden files. Defaults to false."),
    },
    async ({ dir_path, recursive, max_depth, show_hidden }) => {
      const res = await executeListDirectory({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        dirPath: dir_path,
        recursive: recursive ?? false,
        maxDepth: max_depth ?? 2,
        showHidden: show_hidden ?? false,
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

  // 11. file_metadata
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

  // 12. search_code
  registerTool(
    "search_code",
    "High-speed code search powered by ripgrep with line numbers and file matching.",
    {
      query: z.string().describe("Text or regex to search for."),
      dir_path: z.string().optional().describe("Subdirectory to search."),
      case_sensitive: z.boolean().optional().describe("Case sensitivity. Defaults to false."),
      glob_filter: z.string().optional().describe("File pattern filter (e.g. *.ts)."),
      max_results: z.number().int().positive().optional().describe("Max match count. Defaults to 100."),
    },
    async ({ query, dir_path, case_sensitive, glob_filter, max_results }) => {
      const res = executeSearchCode({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        query,
        dirPath: dir_path,
        caseSensitive: case_sensitive ?? false,
        globFilter: glob_filter,
        maxResults: max_results ?? 100,
      });
      return formatMcpResponse(res);
    }
  );

  // 13. get_outline
  registerTool(
    "get_outline",
    "Extracts structural symbols (functions, classes, interfaces, methods, types) from code.",
    {
      file_path: z.string().describe("Path of code file to outline."),
      verbosity: z.enum(["minimal", "detailed"]).optional().describe("Verbosity mode. Defaults to detailed."),
    },
    async ({ file_path, verbosity }) => {
      const res = await executeGetOutline({
        workspaceRoot: getRoot(),
        allowedRoots: config.allowedRoots,
        filePath: file_path,
        verbosity: verbosity ?? "detailed",
      });
      return formatMcpResponse(res);
    }
  );

  // 14. exec_command
  registerTool(
    "exec_command",
    "Executes shell commands with explicit shell selection ('powershell', 'cmd', 'git-bash'). If the process exceeds yield_ms or run_in_background is true, returns a session ID for streaming output.",
    {
      command: z.string().describe("Command line string to execute."),
      shell: z.enum(["powershell", "cmd", "bash", "git-bash", "wsl"]).optional().describe("Shell to run in. Defaults to system recommended shell."),
      timeout_ms: z.number().int().positive().optional().describe("Overall timeout. Defaults to 60000ms."),
      yield_ms: z.number().int().positive().optional().describe("Yield window. If command exceeds this duration, yields running session. Defaults to 2000ms."),
      run_in_background: z.boolean().optional().describe("Run immediately in background. Defaults to false."),
    },
    async ({ command, shell, timeout_ms, yield_ms, run_in_background }) => {
      const res = await processManager.execCommand({
        command,
        cwd: getRoot(),
        shell,
        timeoutMs: timeout_ms,
        yieldMs: yield_ms,
        runInBackground: run_in_background,
      });
      return formatMcpResponse(res);
    }
  );

  // 15. read_process_output
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

  // 16. write_stdin
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

  // 17. interrupt_process
  registerTool(
    "interrupt_process",
    "Terminates a process session and all its child process trees cleanly.",
    {
      session_id: z.string().describe("Session ID to terminate."),
    },
    async ({ session_id }) => {
      const res = await processManager.interruptProcess(session_id);
      return formatMcpResponse(res);
    }
  );

  // 18. browser_navigate
  registerTool(
    "browser_navigate",
    "Navigates the persistent Chromium browser session to a URL and verifies load status.",
    {
      url: z.string().describe("URL to navigate to."),
      session_id: z.string().optional().describe("Browser session ID. Defaults to 'default'."),
    },
    async ({ url, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeNavigate(session, url);
      return formatMcpResponse(res);
    }
  );

  // 19. browser_snapshot
  registerTool(
    "browser_snapshot",
    "Builds an accessible interactive element tree with stable element references ([ref=e1], [ref=e2]) and version tracking.",
    {
      session_id: z.string().optional().describe("Browser session ID. Defaults to 'default'."),
    },
    async ({ session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await takeBrowserSnapshot(session);
      return formatMcpResponse(res);
    }
  );

  // 20. browser_click
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

  // 21. browser_fill
  registerTool(
    "browser_fill",
    "Fills an input element with text and performs mandatory DOM readback verification.",
    {
      ref: z.string().optional().describe("Element reference from browser_snapshot (e.g. 'e1')."),
      selector: z.string().optional().describe("CSS selector."),
      value: z.string().describe("Text value to fill."),
      session_id: z.string().optional().describe("Browser session ID."),
    },
    async ({ ref, selector, value, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeFill(session, { ref, selector }, value);
      return formatMcpResponse(res);
    }
  );

  // 22. browser_check
  registerTool(
    "browser_check",
    "Checks or unchecks a checkbox with mandatory DOM .isChecked() readback verification.",
    {
      ref: z.string().optional().describe("Element reference from browser_snapshot (e.g. 'e1')."),
      selector: z.string().optional().describe("CSS selector."),
      checked: z.boolean().optional().describe("Target checked state. Defaults to true."),
      session_id: z.string().optional().describe("Browser session ID."),
    },
    async ({ ref, selector, checked = true, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeCheck(session, { ref, selector }, checked);
      return formatMcpResponse(res);
    }
  );

  // 23. browser_press_key
  registerTool(
    "browser_press_key",
    "Presses a keyboard key on the browser page (e.g. 'Enter', 'Tab').",
    {
      key: z.string().describe("Key name (e.g. 'Enter', 'Tab', 'Escape')."),
      session_id: z.string().optional().describe("Browser session ID."),
    },
    async ({ key, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executePressKey(session, key);
      return formatMcpResponse(res);
    }
  );

  // 24. browser_screenshot
  registerTool(
    "browser_screenshot",
    "Captures a screenshot of the browser page, verifies disk persistence, and attaches the base64 image block for direct visual inspection by the model.",
    {
      full_page: z.boolean().optional().describe("Capture full scrollable page. Defaults to false."),
      output_path: z.string().optional().describe("Optional path to save screenshot file."),
      session_id: z.string().optional().describe("Browser session ID."),
    },
    async ({ full_page, output_path, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executeBrowserScreenshot({
        session,
        outputPath: output_path,
        fullPage: full_page ?? false,
      });
      return formatMcpResponse(res.toolResponse, { image: res.imagePayload });
    }
  );

  // 25. git_status
  registerTool(
    "git_status",
    "Checks git working tree status and branch name.",
    {},
    async () => {
      const res = executeGitStatus(getRoot());
      return formatMcpResponse(res);
    }
  );

  // 26. git_diff
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

  // 27. show_changes
  registerTool(
    "show_changes",
    "Shows unified summary of all uncommitted modifications and git diff.",
    {},
    async () => {
      const res = executeShowChanges(getRoot());
      return formatMcpResponse(res);
    }
  );

  // 28. revert_changes
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

  // 29. task_create
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

  // 30. task_update
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

  // 31. task_list
  registerTool(
    "task_list",
    "Lists all tasks and their current status.",
    {},
    async () => {
      const res = taskStore.listTasks();
      return formatMcpResponse(res);
    }
  );

  // 32. devspace_diagnostics
  registerTool(
    "devspace_diagnostics",
    "Returns comprehensive health diagnostics, shell availability, browser status, and tool reliability audit logs.",
    {},
    async () => {
      const res = observabilityManager.getDiagnostics();
      return formatMcpResponse(res);
    }
  );

  return server;
}
