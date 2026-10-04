import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createServer, type Server } from "node:http";
import { createDevSpaceApp } from "../src/server/app.js";
import { workspaceManager } from "../src/workspace/workspace_manager.js";
import type { DevSpaceConfig } from "../src/types/index.js";

function parseMcpPayload(text: string): any {
  // If text is SSE event stream
  const match = text.match(/data:\s*({.*})/);
  if (match) {
    return JSON.parse(match[1]);
  }
  return JSON.parse(text);
}

describe("DevSpace 4.0 Server & MCP End-to-End Test", () => {
  let server: Server;
  const testPort = 7985;
  const baseUrl = `http://127.0.0.1:${testPort}`;
  const ownerToken = "test-token-devspace-4";

  before(async () => {
    const config: DevSpaceConfig = {
      port: testPort,
      host: "127.0.0.1",
      publicBaseUrl: baseUrl,
      ownerToken,
      allowedRoots: [process.cwd()],
      worktreesDir: "",
    };

    const instance = createDevSpaceApp(config);
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
    assert.strictEqual(json.service, "DevSpace 4.0");
    assert.strictEqual(json.version, "4.0.0");
  });

  it("serves RFC 9728 and RFC 8414 metadata", async () => {
    const resProt = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    assert.strictEqual(resProt.status, 200);
    const protJson = await resProt.json();
    assert.strictEqual(protJson.resource_name, "DevSpace 4.0 MCP Server");

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
    assert.strictEqual(initJson.result.serverInfo.name, "devspace-4.0");
    assert.strictEqual(initJson.result.serverInfo.version, "4.0.0");

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
    assert.ok(tools.length >= 25, `Expected >= 25 tools, found ${tools.length}`);

    const toolNames = tools.map((t: any) => t.name);
    assert.ok(toolNames.includes("open_workspace"));
    assert.ok(toolNames.includes("apply_patch"));
    assert.ok(toolNames.includes("edit_file"));
    assert.ok(toolNames.includes("write_file"));
    assert.ok(toolNames.includes("read_file"));
    assert.ok(toolNames.includes("browser_snapshot"));
    assert.ok(toolNames.includes("browser_click"));
    assert.ok(toolNames.includes("browser_fill"));
    assert.ok(toolNames.includes("browser_screenshot"));
    assert.ok(toolNames.includes("exec_command"));
    assert.ok(toolNames.includes("read_process_output"));
    assert.ok(toolNames.includes("search_code"));
    assert.ok(toolNames.includes("get_outline"));
    assert.ok(toolNames.includes("devspace_diagnostics"));

    // 3. Call devspace_diagnostics
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
          name: "devspace_diagnostics",
          arguments: {},
        },
      }),
    });

    assert.strictEqual(diagRes.status, 200);
    const diagText = await diagRes.text();
    const diagJson = parseMcpPayload(diagText);
    assert.ok(diagJson.result.content[0].text.includes("DevSpace 4.0 System Diagnostics"));
  });
});
