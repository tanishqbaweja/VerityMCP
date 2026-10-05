import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { VerityConfig } from "../types/index.js";
import { formatMcpResponse, type McpToolResponse } from "./response.js";
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
  executeShowChanges,
  executeRevertChanges,
} from "../git/git_ops.js";
import { taskStore } from "../tasks/task_store.js";
import { subagentEngine } from "../agents/subagent_engine.js";
import { detectEnvironment } from "../environment/env_detector.js";
import { observabilityManager } from "../observability/diagnostics.js";

export function createVerityMcpServer(config: VerityConfig): McpServer {
  const server = new McpServer(
    {
      name: "verity-mcp",
      version: "1.0.0",
    },
    {
      instructions: `You are connected to VerityMCP on the user's local machine.

VerityMCP Core Philosophy:
AN AGENT MUST BE ABLE TO TRUST ITS TOOLS.
All filesystem mutations, patch applications, git reverts, process executions, browser interactions, and screenshots are verified against real system state before reporting success.`,
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
    "Terminates a process session and all its child process trees cleanly.",
    {
      session_id: z.string().describe("Session ID to terminate."),
    },
    async ({ session_id }) => {
      const res = await processManager.interruptProcess(session_id);
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
      const session = await browserManager.getSession(session_id);
      if (url) {
        await executeNavigate(session, url);
      }
      return formatMcpResponse({
        success: true,
        action: `browser_open "${session_id}"`,
        text: `Browser session "${session_id}" is active.`,
        verification: { performed: true, passed: true, method: "browser_session_init" },
        data: { sessionId: session_id },
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

  // 30. browser_snapshot
  registerTool(
    "browser_snapshot",
    "Builds an accessible interactive element tree with stable element references ([ref=e1], [ref=e2]) and version tracking.",
    {
      session_id: z.string().optional().describe("Browser session ID. Defaults to 'default'."),
      verbosity: z.enum(["interactive", "normal", "full"]).optional().describe("Snapshot detail level. Defaults to 'normal'."),
    },
    async ({ session_id = "default", verbosity = "normal" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await takeBrowserSnapshot(session, { verbosity });
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
    },
    async ({ output_path, session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = await executePdf(session, output_path);
      return formatMcpResponse(res);
    }
  );

  // 42. browser_console
  registerTool(
    "browser_console",
    "Retrieves captured console logs from the browser session.",
    {
      session_id: z.string().optional(),
    },
    async ({ session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = executeGetConsole(session);
      return formatMcpResponse(res);
    }
  );

  // 43. browser_network
  registerTool(
    "browser_network",
    "Retrieves captured network requests and responses from the browser session.",
    {
      session_id: z.string().optional(),
    },
    async ({ session_id = "default" }) => {
      const session = await browserManager.getSession(session_id);
      const res = executeGetNetwork(session);
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

  // 45. screenshot_desktop
  registerTool(
    "screenshot_desktop",
    "Captures the entire desktop or a rectangular region (outside the browser) and returns visual base64 image payload.",
    {
      output_path: z.string().optional(),
      region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
    },
    async ({ output_path, region }) => {
      const res = await executeDesktopScreenshot({ outputPath: output_path, region });
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

  // 60. delegate_subagent
  registerTool(
    "delegate_subagent",
    "Spawns a bounded subagent with a specific persona ('explore', 'coding', 'review', 'verification', 'planning') to perform focused tasks.",
    {
      task: z.string().describe("Specific subagent task prompt."),
      persona: z.enum(["explore", "coding", "review", "verification", "planning"]).optional().describe("Subagent persona. Defaults to explore."),
      context: z.string().optional().describe("Bounded context."),
    },
    async ({ task, persona, context }) => {
      const res = subagentEngine.delegateSubagent(task, persona, context);
      return formatMcpResponse(res);
    }
  );

  // 61. list_subagents
  registerTool(
    "list_subagents",
    "Lists active and recently completed subagents.",
    {},
    async () => {
      const res = subagentEngine.listSubagents();
      return formatMcpResponse(res);
    }
  );

  // 62. enter_plan_mode
  registerTool(
    "enter_plan_mode",
    "Enters Plan Mode to formulate and refine actions before direct execution.",
    {},
    async () => {
      const res = subagentEngine.enterPlanMode();
      return formatMcpResponse(res);
    }
  );

  // 63. exit_plan_mode
  registerTool(
    "exit_plan_mode",
    "Exits Plan Mode with an approved plan and resumes direct execution.",
    {
      plan: z.string().describe("The final approved plan text."),
      approved_actions: z.array(z.string()).optional().describe("Approved action summaries."),
    },
    async ({ plan, approved_actions }) => {
      const res = subagentEngine.exitPlanMode(plan, approved_actions);
      return formatMcpResponse(res);
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

  return server;
}
