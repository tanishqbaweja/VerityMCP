# DevSpace 4.0

> **"AN AGENT MUST BE ABLE TO TRUST ITS TOOLS."**
> A tool returning success when nothing happened is worse than a tool returning an error.

DevSpace 4.0 is an enterprise-grade local Model Context Protocol (MCP) engineering server designed for autonomous coding agents (ChatGPT, Claude, Codex, and Antigravity).

It combines:
- The simple, rock-solid reliability of **DevSpace**
- The ergonomic workspace onboarding and high-signal repo map of **DevSpace 2.0**
- The deep coding intelligence and tool breadth of **DevSpace 3.0**
- Substantially stronger verification, observability, Windows-first shell runtime, and first-class Playwright browser automation than any predecessor.

---

## Architecture & Subsystems

```
                               ┌─────────────────────────────────────────┐
                               │       DevSpace 4.0 MCP Server           │
                               │        (Port 7980, Streamable)          │
                               └────────────────────┬────────────────────┘
                                                    │
        ┌───────────────────┬───────────────────────┼───────────────────────┬───────────────────┐
        ▼                   ▼                       ▼                       ▼                   ▼
┌───────────────┐   ┌───────────────┐       ┌───────────────┐       ┌───────────────┐   ┌───────────────┐
│   Workspace   │   │  Filesystem   │       │  Patch & Edit │       │    Browser    │   │  Shell/Task   │
│    Manager    │   │    Engine     │       │    Engine     │       │   Automaton   │   │    Runtime    │
└───────┬───────┘   └───────┬───────┘       └───────┬───────┘       └───────┬───────┘   └───────┬───────┘
        │                   │                       │                       │                   │
        ▼                   ▼                       ▼                       ▼                   ▼
┌───────────────┐   ┌───────────────┐       ┌───────────────┐       ┌───────────────┐   ┌───────────────┐
│ Repo Map &    │   │ Read, Write,  │       │ Atomic Patch  │       │ Persistent    │   │ Durable Chunks│
│ Shell Prober  │   │ Move, Delete  │       │ Exact-String  │       │ Chromium,     │   │ Cursors,      │
│ Skills/Agents │   │ Hash Check    │       │ Rollback Tree │       │ Verified DOM  │   │ Windows ConPTY│
└───────────────┘   └───────────────┘       └───────────────┘       └───────────────┘   └───────────────┘
        │                   │                       │                       │                   │
        └───────────────────┴───────────────────────┼───────────────────────┴───────────────────┘
                                                    │
                                                    ▼
                                    ┌───────────────────────────────┐
                                    │      VERIFICATION ENGINE      │
                                    │  - Readback SHA-256 byte check│
                                    │  - fs_stat existence checks   │
                                    │  - Relocation validation      │
                                    │  - DOM inputValue readbacks   │
                                    │  - Git status/diff audits     │
                                    └───────────────────────────────┘
```

---

## How Predecessor Defects Were Eliminated

| Predecessor Defect | Root Cause in Predecessor | DevSpace 4.0 Solution |
| :--- | :--- | :--- |
| **DevSpace 2.0 Patch False-Success** | `applyHunksToFile` returned unchanged original text when no hunks matched or hunk headers were empty, but pushed the file to `filesModified` and claimed success. | **Mandatory Pre/Post Verification**: Checks that patch contains >0 hunks, detects no-op identical updates, and performs post-mutation SHA-256 byte readback (`actualBytes === expectedBytes`). Rolls back atomically on mismatch. |
| **DevSpace 3.0 Windows Bash Crash** | Hardcoded Git Bash paths fell back to `"bash"`. On Windows, this called WSL's `C:\Windows\System32\bash.exe`, failing with `execvpe(/bin/bash) failed: No such file or directory`. | **Windows-First Shell Detector**: Probes PowerShell 7/5.1, cmd.exe, verified Git Bash paths, and checked WSL distros. If Bash is unavailable on Windows, throws an actionable `BASH_NOT_AVAILABLE` error guiding the model to use PowerShell or cmd. |
| **DevSpace 3.0 Background Task Empty Output** | Primitive string closure in `process_manager.ts` (`task.stdout = ""`) was never mutated when data chunks arrived on `child.stdout`. | **Durable Chunk Buffering & Pagination**: Output chunks are appended to a persistent array with stream, timestamp, and byte counts. Supports cursor pagination (`read_process_output(sessionId, cursor)`). Output is never dropped. |
| **DevSpace 3.0 Plain Text Image Read** | Reading binary PNG/JPEG images returned plain text `[Image file: path ...]`, leaving models blind to visual evidence. | **Dual MCP Image Payload**: Automatically detects image extensions (`.png`, `.jpg`, `.svg`, etc.), reads binary buffer, and returns both metadata text AND a direct base64 MCP image block (`{ type: "image", data: base64, mimeType }`). |
| **Browser Fragility** | Fragile npx CLI spawning without session retention or verified DOM interaction. | **First-Class Playwright Subsystem**: Persistent browser contexts, accessible interactive snapshot trees with stable refs `[ref=e1]`, verified click/fill/check with DOM readback, and screenshots saved to disk and returned as base64 images. |

---

## Complete Toolset (32 Verified Tools)

### 1. Workspace
- `open_workspace`: Opens a workspace root. In a single call, returns architectural repo map, git branch/clean status, detected shells, package scripts, and available skills.

### 2. Filesystem & Mutation
- `read_file`: Reads files with line slicing (`line_start`, `line_end`) and SHA-256 hash. Returns direct image payload if reading image files.
- `write_file`: Writes file with mandatory post-write byte readback and SHA-256 verification.
- `edit_file`: Performs exact-string replacement with cardinality check, unified diff output, and post-mutation hash verification.
- `apply_patch`: Applies multi-file Codex or unified patches with atomic staging, rollback, and mandatory post-mutation byte readback.
- `delete_file`: Deletes file or directory with post-deletion existence verification.
- `move_file`: Moves/renames file with source-unlinked and destination-exists verification.
- `copy_file`: Copies file with byte-equality verification.
- `list_directory`: Lists directory contents with depth and ignore filtering.
- `locate_files`: Fast file locator by glob pattern or name substring.
- `file_metadata`: Inspects file stats, SHA-256 hash, line count, and binary status.

### 3. Code Intelligence
- `search_code`: High-speed code search powered by native ripgrep with line numbers and file matching.
- `get_outline`: Structural symbol extraction (functions, classes, interfaces, methods, types) from code files.

### 4. Shell & Processes
- `exec_command`: Runs commands in explicit shells (`powershell`, `cmd`, `git-bash`). Yields session ID if running longer than `yield_ms`.
- `read_process_output`: Streams stdout/stderr chunks from running or completed processes using pagination cursors.
- `write_stdin`: Sends interactive input to running process session stdin.
- `interrupt_process`: Terminates process tree cleanly using Windows `taskkill` or SIGINT.

### 5. Browser Automation (First-Class Playwright)
- `browser_navigate`: Navigates persistent browser session to a URL and verifies load status.
- `browser_snapshot`: Builds an accessibility tree with stable element references (`[ref=e1]`) and version tracking.
- `browser_click`: Clicks element by reference or selector.
- `browser_fill`: Fills input and performs mandatory DOM readback verification.
- `browser_check`: Checks or unchecks a checkbox with mandatory DOM `.isChecked()` verification.
- `browser_press_key`: Presses keyboard keys (e.g. `Enter`, `Tab`).
- `browser_screenshot`: Captures viewport or full page, verifies disk file, and returns base64 image block for visual inspection.

### 6. Git Engine
- `git_status`: Checks git working tree status and branch name.
- `git_diff`: Returns git diff against HEAD or specified ref.
- `show_changes`: Shows unified summary of all uncommitted modifications and diffs.
- `revert_changes`: Reverts uncommitted changes with mandatory post-revert git status verification.

### 7. Tasks & Planning
- `task_create`: Creates a new task in the planning store.
- `task_update`: Updates task status (`pending`, `in_progress`, `completed`, `failed`).
- `task_list`: Lists all tasks and active planning state.

### 8. Diagnostics & Observability
- `devspace_diagnostics`: Returns system health diagnostics, shell availability, browser status, and tool reliability audit logs.

---

## Getting Started

### Prerequisites
- Node.js >= 20
- pnpm >= 9
- Chromium (installed via `playwright`)

### Running DevSpace 4.0

```powershell
# From H:\Github Repositories\devspace 4.0
pnpm start
```

Or on Windows:
```cmd
start.bat
```

### Dedicated Port
DevSpace 4.0 runs on dedicated port **`7980`**:
- **MCP Endpoint**: `http://127.0.0.1:7980/mcp`
- **Health Check**: `http://127.0.0.1:7980/healthz`
- **OAuth Discovery**: `http://127.0.0.1:7980/.well-known/oauth-authorization-server`
- **Protected Resource**: `http://127.0.0.1:7980/.well-known/oauth-protected-resource`

---

## Test Verification

Run the complete test suite:
```powershell
pnpm test
```

Includes:
- `test/patcher.test.ts`: Codex patch, unified diff, and reproduction & prevention of DevSpace 2.0 false-success defect.
- `test/process_manager.test.ts`: Process execution, yield windows, and reproduction & prevention of DevSpace 3.0 empty output defect.
- `test/browser.test.ts`: Playwright navigation, snapshot refs, verified form fill, verified checkbox check, and screenshot capture.
- `test/server.test.ts`: HTTP MCP end-to-end initialize, RFC 8414/9728 metadata, and tool invocation.
- `test/acceptance.test.ts`: Comprehensive acceptance across all 32 tools and verifications.
