import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createServer, type Server } from "node:http";
import { createVerityApp } from "../src/server/app.js";
import { workspaceManager } from "../src/workspace/workspace_manager.js";
import type { VerityConfig } from "../src/types/index.js";

function parseMcpPayload(text: string): any {
  // If text is SSE event stream
  const match = text.match(/data:\s*({.*})/);
  if (match) {
    return JSON.parse(match[1]);
  }
  return JSON.parse(text);
}

const EXPECTED_TOOL_NAMES = [
  "open_workspace",
  "read_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "delete_file",
  "move_file",
  "copy_file",
  "list_directory",
  "locate_files",
  "glob_files",
  "file_metadata",
  "search_code",
  "get_outline",
  "lsp_query",
  "exec_command",
  "read_process_output",
  "write_stdin",
  "interrupt_process",
  "kill_process",
  "browser_open",
  "browser_close",
  "browser_list",
  "browser_navigate",
  "page_reload",
  "page_back",
  "page_forward",
  "browser_tab_new",
  "browser_tab_select",
  "browser_tab_close",
  "browser_list_tabs",
  "browser_snapshot",
  "browser_click",
  "browser_wait_for",
  "browser_trace_start",
  "browser_trace_stop",
  "browser_double_click",
  "browser_hover",
  "browser_fill",
  "browser_check",
  "browser_uncheck",
  "browser_select",
  "browser_upload",
  "browser_press_key",
  "browser_eval",
  "browser_pdf",
  "browser_console",
  "browser_network",
  "browser_screenshot",
  "screenshot_desktop",
  "list_windows",
  "focus_window",
  "read_notebook",
  "edit_notebook",
  "git_status",
  "git_diff",
  "git_conflicts",
  "show_changes",
  "revert_changes",
  "enter_worktree",
  "exit_worktree",
  "list_worktrees",
  "task_create",
  "task_update",
  "task_list",
  "activity_list",
  "activity_read",
  "activity_clear",
  "activity_monitor",
  "get_environment",
  "list_skills",
  "read_skill",
  "verity_diagnostics",
  "verity_self_test",
  "verity_acceptance_test",
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
] as const;

describe("VerityMCP Server & MCP End-to-End Test", () => {
  let server: Server;
  const testPort = 7985;
  const baseUrl = `http://127.0.0.1:${testPort}`;
  const ownerToken = "test-token-verity";

  before(async () => {
    const config: VerityConfig = {
      port: testPort,
      host: "127.0.0.1",
      publicBaseUrl: baseUrl,
      ownerToken,
      allowedRoots: [process.cwd()],
      worktreesDir: "",
    };

    const instance = createVerityApp(config);
    server = createServer(instance.app);
    await new Promise<void>((resolve) => server.listen(testPort, "127.0.0.1", resolve));
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves healthz", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.service, "VerityMCP");
    assert.strictEqual(json.version, "1.0.0");
  });

  it("serves RFC 9728 and RFC 8414 metadata", async () => {
    const resProt = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    assert.strictEqual(resProt.status, 200);
    const protJson = await resProt.json();
    assert.strictEqual(protJson.resource_name, "VerityMCP Server");

    const resAuth = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    assert.strictEqual(resAuth.status, 200);
    const authJson = await resAuth.json();
    assert.strictEqual(authJson.issuer, baseUrl);
  });

  it("rejects unauthorized MCP request without Bearer token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0" },
        },
      }),
    });
    assert.strictEqual(res.status, 401);
  });

  it("initializes MCP and lists tools with valid Bearer token", async () => {
    // 1. Initialize
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0" },
        },
      }),
    });

    assert.strictEqual(initRes.status, 200);
    const initText = await initRes.text();
    const initJson = parseMcpPayload(initText);
    assert.strictEqual(initJson.result.serverInfo.name, "verity-mcp");
    assert.strictEqual(initJson.result.serverInfo.version, "1.0.0");

    // 2. Tools list
    const toolsRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });

    assert.strictEqual(toolsRes.status, 200);
    const toolsText = await toolsRes.text();
    const toolsJson = parseMcpPayload(toolsText);
    const tools = toolsJson.result.tools;
    assert.ok(Array.isArray(tools));
    const toolNames = tools.map((t: any) => t.name);
    assert.deepStrictEqual(
      [...toolNames].sort(),
      [...EXPECTED_TOOL_NAMES].sort(),
      "tools/list must expose exactly the audited tool contract"
    );

    for (const tool of tools) {
      assert.ok(tool.annotations, `${tool.name} must declare MCP annotations`);
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        assert.strictEqual(
          typeof tool.annotations[hint],
          "boolean",
          `${tool.name}.${hint} must be an explicit boolean`
        );
      }
    }

    const byName = new Map(tools.map((tool: any) => [tool.name, tool]));
    assert.deepStrictEqual(byName.get("read_file")?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.strictEqual(byName.get("delete_file")?.annotations?.destructiveHint, true);
    assert.strictEqual(byName.get("exec_command")?.annotations?.openWorldHint, true);
    assert.strictEqual(byName.get("browser_click")?.annotations?.destructiveHint, true);

    // 3. Call verity_diagnostics
    const diagRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "verity_diagnostics",
          arguments: {},
        },
      }),
    });

    assert.strictEqual(diagRes.status, 200);
    const diagText = await diagRes.text();
    const diagJson = parseMcpPayload(diagText);
    assert.ok(diagJson.result.content[0].text.includes("VerityMCP System Diagnostics"));
  });
});
