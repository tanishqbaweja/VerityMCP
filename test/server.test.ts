import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createServer, type Server } from "node:http";
import { createVerityApp } from "../src/server/app.js";
import { workspaceManager } from "../src/workspace/workspace_manager.js";
import { runManager } from "../src/runs/run_manager.js";
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
  "task_bootstrap",
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
  "discover_tools",
  "invoke_tool",
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
    const sessionId = initRes.headers.get("mcp-session-id");
    assert.ok(sessionId, "Expected server-issued mcp-session-id");
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
        "mcp-session-id": sessionId,
        "MCP-Protocol-Version": "2024-11-05",
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
    const fullProfile = (process.env.VERITY_TOOL_PROFILE || "fast").trim().toLowerCase() === "full";
    if (fullProfile) {
      assert.deepStrictEqual(
        [...toolNames].sort(),
        [...EXPECTED_TOOL_NAMES].sort(),
        "full tools/list must expose exactly the audited tool contract"
      );
    } else {
      assert.ok(toolNames.length < 50, `Fast profile should expose < 50 tools, found ${toolNames.length}`);
      assert.ok(!toolNames.includes("file_metadata"), "file_metadata should be deferred in the default fast profile");
      for (const required of [
        "open_workspace",
        "task_bootstrap",
        "apply_patch",
        "edit_file",
        "write_file",
        "read_file",
        "browser_snapshot",
        "browser_click",
        "browser_fill",
        "browser_screenshot",
        "exec_command",
        "read_process_output",
        "search_code",
        "get_outline",
        "verity_diagnostics",
        "discover_tools",
        "invoke_tool",
      ]) {
        assert.ok(toolNames.includes(required), `Fast profile missing expected hot-path tool: ${required}`);
      }
    }

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
    assert.strictEqual(byName.get("apply_patch")?.annotations?.destructiveHint, true);
    assert.strictEqual(byName.get("exec_command")?.annotations?.openWorldHint, true);
    assert.strictEqual(byName.get("browser_click")?.annotations?.destructiveHint, true);

    // 3. Call verity_diagnostics
    const diagRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ownerToken}`,
        "mcp-session-id": sessionId,
        "MCP-Protocol-Version": "2024-11-05",
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

    // 4. Discover and invoke a deferred specialist tool through the fast gateway.
    const discoverRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ownerToken}`,
        "mcp-session-id": sessionId,
        "MCP-Protocol-Version": "2024-11-05",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "discover_tools",
          arguments: { query: "metadata" },
        },
      }),
    });
    assert.strictEqual(discoverRes.status, 200);
    const discoverJson = parseMcpPayload(await discoverRes.text());
    assert.ok(discoverJson.result.content[0].text.includes("file_metadata"));

    const invokeRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ownerToken}`,
        "mcp-session-id": sessionId,
        "MCP-Protocol-Version": "2024-11-05",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "invoke_tool",
          arguments: {
            name: "file_metadata",
            arguments: { file_path: process.cwd() + "\\package.json" },
          },
        },
      }),
    });
    assert.strictEqual(invokeRes.status, 200);
    const invokeJson = parseMcpPayload(await invokeRes.text());
    assert.ok(invokeJson.result.content[0].text.includes("package.json"));

    const bootstrapRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ownerToken}`,
        "mcp-session-id": sessionId,
        "MCP-Protocol-Version": "2024-11-05",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "task_bootstrap",
          arguments: {
            path: process.cwd(),
            query: "createVerityApp",
            max_matches: 5,
            recent_activity: 2,
          },
        },
      }),
    });
    assert.strictEqual(bootstrapRes.status, 200);
    const bootstrapJson = parseMcpPayload(await bootstrapRes.text());
    assert.ok(bootstrapJson.result.content[0].text.includes("Workspace:"));
    assert.ok(bootstrapJson.result.content[0].text.includes("createVerityApp"));
  });

  it("issues and isolates stateful HTTP MCP sessions", async () => {
    let sessionA: string | undefined;
    let sessionB: string | undefined;
    let runAId: string | undefined;
    let runBId: string | undefined;

    const initializeSession = async (id: number, clientName: string): Promise<string> => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: clientName, version: "1.0" },
          },
        }),
      });
      assert.strictEqual(res.status, 200);
      const sessionId = res.headers.get("mcp-session-id");
      assert.ok(sessionId, "Expected server-issued mcp-session-id");
      const payload = parseMcpPayload(await res.text());
      assert.strictEqual(payload.result?.serverInfo?.name, "verity-mcp");
      return sessionId;
    };

    const callTool = async (
      sessionId: string,
      id: number,
      name: string,
      args: Record<string, unknown>
    ) => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${ownerToken}`,
          "mcp-session-id": sessionId,
          "MCP-Protocol-Version": "2024-11-05",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      assert.strictEqual(res.status, 200);
      return parseMcpPayload(await res.text());
    };

    const closeSession = async (sessionId: string) => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${ownerToken}`,
          "mcp-session-id": sessionId,
          "MCP-Protocol-Version": "2024-11-05",
        },
      });
      assert.ok(
        res.status === 200 || res.status === 204,
        `Expected successful MCP session delete, got ${res.status}`
      );
      await res.text();
    };

    try {
      sessionA = await initializeSession(101, "transport-session-A");
      sessionB = await initializeSession(102, "transport-session-B");
      assert.notStrictEqual(sessionA, sessionB);

      const startA = await callTool(sessionA, 103, "start_run", {
        goal: "HTTP transport session A isolation",
        internal_test: true,
        run_kind: "internal_test",
        project_key: "http-session-isolation",
        task_key: "transport-a",
        idempotency_key: `transport-a-${Date.now()}`,
      });
      assert.ok(startA.result?.content?.length > 0);

      const activeA = runManager.getActiveRun(sessionA);
      assert.ok(activeA);
      runAId = activeA.run_id;
      assert.strictEqual(activeA.origin_mcp_session_id, sessionA);

      const startB = await callTool(sessionB, 104, "start_run", {
        goal: "HTTP transport session B isolation",
        internal_test: true,
        run_kind: "internal_test",
        project_key: "http-session-isolation",
        task_key: "transport-b",
        idempotency_key: `transport-b-${Date.now()}`,
      });
      assert.ok(startB.result?.content?.length > 0);

      const activeB = runManager.getActiveRun(sessionB);
      assert.ok(activeB);
      runBId = activeB.run_id;
      assert.strictEqual(activeB.origin_mcp_session_id, sessionB);
      assert.notStrictEqual(runAId, runBId);
      assert.strictEqual(runManager.getActiveRun(sessionA)?.run_id, runAId);
      assert.strictEqual(runManager.getActiveRun(sessionB)?.run_id, runBId);

      await callTool(sessionA, 105, "complete_run", {
        run_id: runAId,
        status: "completed",
        resolve_pending: true,
      });
      assert.strictEqual(runManager.getActiveRun(sessionA), null);
      assert.strictEqual(runManager.getActiveRun(sessionB)?.run_id, runBId);

      await callTool(sessionB, 106, "complete_run", {
        run_id: runBId,
        status: "completed",
        resolve_pending: true,
      });
      assert.strictEqual(runManager.getActiveRun(sessionB), null);

      await closeSession(sessionA);
      await closeSession(sessionB);
      sessionA = undefined;
      sessionB = undefined;
    } finally {
      if (sessionA && runAId && runManager.getActiveRun(sessionA)) {
        await callTool(sessionA, 107, "complete_run", {
          run_id: runAId,
          status: "completed",
          resolve_pending: true,
          allow_cleanup_debt: true,
        }).catch(() => {});
      }
      if (sessionB && runBId && runManager.getActiveRun(sessionB)) {
        await callTool(sessionB, 108, "complete_run", {
          run_id: runBId,
          status: "completed",
          resolve_pending: true,
          allow_cleanup_debt: true,
        }).catch(() => {});
      }
      if (sessionA) await closeSession(sessionA).catch(() => {});
      if (sessionB) await closeSession(sessionB).catch(() => {});
      if (sessionA) runManager.setActiveRun(null, sessionA);
      if (sessionB) runManager.setActiveRun(null, sessionB);
    }
  });

  it("rejects legacy MCP requests without a valid initialized session", async () => {
    const noSession = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 201,
        method: "tools/list",
        params: {},
      }),
    });
    assert.strictEqual(noSession.status, 400);

    const unknown = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ownerToken}`,
        "mcp-session-id": "definitely-not-a-real-session",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 202,
        method: "tools/list",
        params: {},
      }),
    });
    assert.strictEqual(unknown.status, 404);
  });
});
