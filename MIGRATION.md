# Migrating to VerityMCP

VerityMCP is a complete, unified local development and computer execution MCP server that replaces and synthesizes legacy iterations:
- **VerityMCP 1.0** (Port 7676)
- **VerityMCP 2.0** (Port 7878)
- **VerityMCP 3.0** (Port 7979)

It operates on dedicated port **`7980`**, providing zero port collisions with predecessors and strict process isolation.

---

## Why Migrate to VerityMCP?

VerityMCP was built around one non-negotiable principle:
> **"AN AGENT MUST BE ABLE TO TRUST ITS TOOLS."**  
> A tool returning success when nothing happened is worse than a tool returning an error.

### Key Predecessor Defects Eliminated

| Predecessor | Problem | VerityMCP Resolution |
| :--- | :--- | :--- |
| **VerityMCP 2.0** | **Patch False-Success**: When applying patches with unmatched hunks, `apply_patch` silently returned `success: true` while leaving the disk untouched. | **Mandatory Post-Mutation SHA-256 Byte Readback**: Validates hunk count > 0, rejects no-op changes, tests candidate lines against actual disk lines, and compares post-write byte buffer against expected text. |
| **VerityMCP 3.0** | **Windows Bash Crash**: Hardcoded call to `bash` invoked WSL (`C:\Windows\System32\bash.exe`), causing `execvpe(/bin/bash) failed` when WSL was unconfigured. | **Windows-First Shell Detection**: Probes PowerShell 7 (`pwsh`), Windows PowerShell 5.1, `cmd.exe`, verified Git Bash paths, and checked WSL distros. Yields actionable `BASH_NOT_AVAILABLE` error guiding agent to use PowerShell or cmd. |
| **VerityMCP 3.0** | **Background Task Output Dropping**: Primitive string closure (`task.stdout = ""`) remained empty when chunk events fired. Polling returned empty output. | **Durable Chunk Buffering & Pagination**: All output chunks are appended to a persistent ring/buffer with stream, timestamp, and byte counts. Supports cursor pagination (`read_process_output`). |
| **VerityMCP 3.0** | **Blind to Images**: Reading `.png` / `.jpg` files returned plain text `[Image file: ...]`, rendering the model blind. | **Direct MCP Image Content**: Automatically detects binary image mime-types and returns direct `{ type: "image", data: base64, mimeType }` content blocks alongside text metadata. |
| **VerityMCP 1.0 & 2.0** | **Browser Flakiness**: Ad-hoc CLI spawning without session tracking or verified DOM assertions. | **First-Class Persistent Playwright Engine**: Named sessions, accessibility tree snapshots with versioned refs (`[ref=e1]`), verified form fill and checkbox assertions with live DOM readback, and screenshots saved to disk and returned as base64 images. |

---

## Comprehensive Tool Mapping Table

| Capability | VerityMCP 1.0 | VerityMCP 2.0 | VerityMCP 3.0 | VerityMCP Unified Tool | Key Enhancement |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Workspace Init** | `open_workspace` | `open_workspace` | `open_workspace` | `open_workspace` | Returns rich repo map, Git branch/clean status, manifest dependencies, scripts, detected shells, and available skills. |
| **Read File** | `read_file` | `read_file` | `read_file` | `read_file` | Adds line slicing, SHA-256 hash, and direct base64 image blocks for image formats. |
| **Write File** | `write_file` | `write_file` | `write_file` | `write_file` | Mandatory post-write SHA-256 verification and atomic write rollback. |
| **Edit File** | `edit_file` | `edit_file` | `edit_file` | `edit_file` | Exact-string replacement, occurrence validation, unified diff output, and post-mutation hash verification. |
| **Apply Patch** | `apply_patch` | `apply_patch` | `apply_patch` | `apply_patch` | Multi-file atomic patch application, unified diff + Codex support, rejects no-ops, verified byte readback. |
| **Delete File** | `delete_file` | `delete_file` | `delete_file` | `delete_file` | Verified file/directory unlinking with stat check. |
| **Move File** | `move_file` | `move_file` | `move_file` | `move_file` | Verified source removal + destination byte verification. |
| **Copy File** | `copy_file` | `copy_file` | `copy_file` | `copy_file` | Verified byte equality check. |
| **List Directory** | `list_directory` | `list_directory` | `list_directory` | `list_directory` | Recursive directory traversal with ignore patterns and max-depth guards. |
| **Locate Files** | Shell `find` | `find_by_name` | `glob` | `locate_files` | High-speed file globbing and substring matching. |
| **File Metadata** | Shell `stat` | `get_file_info` | `stat` | `file_metadata` | Returns file size, timestamps, SHA-256 hash, line count, and binary status. |
| **Search Code** | Shell `grep` | `search_code` | `grep` | `search_code` | Native ripgrep binary integration with line numbers, regex, and file filtering. |
| **Code Outline** | None | `get_outline` | None | `get_outline` | AST/regex symbol extraction for classes, functions, methods, interfaces, and types. |
| **Language Server (LSP)** | None | None | None | `lsp_goto_definition`, `lsp_find_references`, `lsp_hover`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_type_definition` | Native LSP client support for TypeScript/JavaScript/Python with configurable verbosity (`outline`, `normal`, `full`). |
| **Jupyter Notebooks** | Plain text read | None | None | `read_notebook`, `edit_notebook` | Structural cell inspection (markdown/code/outputs) and verified cell replacement/insertion/deletion. |
| **Run Command** | `exec_command` | `exec_command` | `bash` | `exec_command` | Windows-first shell runtime (`powershell`, `cmd`, `git-bash`), yield timeout window, session retention. |
| **Read Process Output**| `read_output` | `read_output` | `get_task_output` | `read_process_output` | Durable chunk buffering with offset/cursor pagination. |
| **Write Process Stdin** | `write_stdin` | `write_stdin` | `send_input` | `write_stdin` | Sends interactive input to running process sessions. |
| **Interrupt Process** | `kill_process` | `kill_process` | `kill_task` | `interrupt_process` | Clean process termination via Windows `taskkill /F /T` or SIGINT. |
| **Environment Audit** | None | None | `get_env` | `get_environment` | System audit of Node, pnpm, Python, uv, Git, Docker, and shells. |
| **Browser Navigate** | Playwright CLI | `browser_navigate` | None | `browser_navigate` | Navigates persistent browser session with verified load status. |
| **Browser Snapshot** | Playwright CLI | `browser_snapshot` | None | `browser_snapshot` | Accessibility tree with stable refs `[ref=e1]`, labels, values, and version tracking. |
| **Browser Form Fill**| Playwright CLI | `browser_fill` | None | `browser_fill` | Verified form fill with live DOM `inputValue` readback check. |
| **Browser Checkbox** | Playwright CLI | `browser_check` | None | `browser_check` | Verified checkbox toggle with live DOM `isChecked` readback check. |
| **Browser Screenshot**| Playwright CLI | `browser_screenshot`| None | `browser_screenshot` | Saves screenshot to disk, verifies file integrity, and returns MCP base64 image block. |
| **Browser Actions** | None | Limited | None | `browser_click`, `browser_double_click`, `browser_hover`, `browser_select_option`, `browser_upload_file`, `browser_press_key`, `browser_evaluate`, `browser_pdf`, `browser_console_logs`, `browser_network_requests`, `browser_close` | Complete interactive browser surface. |
| **Desktop Automation** | None | None | None | `screenshot_desktop`, `list_windows`, `focus_window` | Windows GDI desktop screenshot with base64 image return and window focus management. |
| **Git Operations** | Shell git | `git_status`, `git_diff` | Shell git | `git_status`, `git_diff`, `show_changes`, `revert_changes` | Unified changes overview, uncommitted diffs, and verified git revert with status audit. |
| **Git Worktrees** | Shell worktree | Limited | None | `worktree_create`, `worktree_list`, `worktree_remove` | Isolated worktree management with dirty state safety checks. |
| **Task Planning** | None | `task_*` | None | `task_create`, `task_update`, `task_list` | Persistent task store for structured multi-step planning and tracking. |
| **Live Activity Stream** | None | None | None | `activity_list`, `activity_read`, `activity_clear` | First-class operational event streaming with cursor pagination without exposing model chain-of-thought. |
| **Observability & Tests** | None | None | None | `verity_diagnostics`, `verity_self_test`, `verity_acceptance_test` | Comprehensive system diagnostics, audit logs, and non-destructive end-to-end self/acceptance tests. |

---

## Client Configuration Migration

To switch your MCP client configuration (e.g., ChatGPT Web, Cursor) to VerityMCP:

### 1. ChatGPT Web MCP Configuration (Streamable HTTP / SSE)

Connect over Streamable HTTP:

```json
{
  "mcpServers": {
    "verity-mcp": {
      "url": "http://127.0.0.1:7980/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_VERITY_AUTH_TOKEN"
      }
    }
  }
}
```

*(Note: Find your auth token in `~/.verity/auth.json` or use the owner token printed during startup).*

---

## Response Envelope Standard

All VerityMCP tools return a strictly typed `StandardToolResponse`:

```typescript
export interface StandardToolResponse<T = any> {
  success: boolean;
  action: string;
  text: string;
  verification: {
    performed: boolean;
    passed: boolean;
    method: string;
    details?: any;
    error?: string;
  };
  data?: T;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs: number;
}
```

When an operation generates or reads visual content (such as `read_file` on images, `browser_screenshot`, or `screenshot_desktop`), the MCP response returns both textual metadata and a compliant MCP Image Content block:
```json
{
  "content": [
    {
      "type": "text",
      "text": "Screenshot captured successfully..."
    },
    {
      "type": "image",
      "data": "iVBORw0KGgoAAAANSUhEUgAA...",
      "mimeType": "image/png"
    }
  ]
}
```

This guarantees autonomous models receive direct visual evidence without extra file reading roundtrips.
