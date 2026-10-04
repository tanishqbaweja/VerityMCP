#!/usr/bin/env node
import { createServer } from "node:http";
import net from "node:net";
import { loadConfig } from "./config/index.js";
import { createDevSpaceApp } from "./server/app.js";
import { workspaceManager } from "./workspace/workspace_manager.js";
import { detectShells } from "./shell/shell_detector.js";

async function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.once("close", () => resolve(true)).close();
      })
      .listen(port, host);
  });
}

async function findAvailablePort(startPort: number, host: string): Promise<number> {
  let port = startPort;
  while (port < startPort + 50) {
    if (await isPortAvailable(port, host)) {
      return port;
    }
    port++;
  }
  return startPort;
}

export async function main() {
  const config = loadConfig();

  // Parse basic arguments
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "serve") {
      continue;
    } else if (args[i] === "--port" && args[i + 1]) {
      config.port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--host" && args[i + 1]) {
      config.host = args[i + 1];
      i++;
    } else if (args[i] === "--token" && args[i + 1]) {
      config.ownerToken = args[i + 1];
      i++;
    } else if (args[i] === "--public-base-url" && args[i + 1]) {
      config.publicBaseUrl = args[i + 1];
      i++;
    }
  }

  const effectivePort = await findAvailablePort(config.port, config.host);
  if (effectivePort !== config.port) {
    console.warn(`[DevSpace 4.0] Warning: Port ${config.port} was busy. Auto-selected port ${effectivePort}.`);
    config.port = effectivePort;
  }

  // Auto-open workspace for current working directory
  await workspaceManager.openWorkspace(process.cwd(), config.allowedRoots);

  const instance = createDevSpaceApp(config);
  const shells = detectShells();

  const server = createServer(instance.app);

  server.listen(config.port, config.host, () => {
    const mcpUrl = config.publicBaseUrl ? `${config.publicBaseUrl}/mcp` : `http://${config.host}:${config.port}/mcp`;
    console.log(`
============================================================
       VERITY MCP - LOCAL COMPUTER RUNTIME FOR CHATGPT & CLAUDE
============================================================
Status:         ONLINE & READY
Port:           ${config.port}
Host:           ${config.host}
Endpoint (MCP): ${mcpUrl}
${config.publicBaseUrl ? `Public Tunnel:  ${config.publicBaseUrl}` : ""}
Health Check:   http://${config.host}:${config.port}/healthz
Default Shell:  ${shells.defaultShell} (${shells.powershell.available ? "PowerShell" : "cmd"})
Git Bash:       ${shells.gitBash.available ? shells.gitBash.description : "Not detected"}
Active Root:    ${workspaceManager.getActiveWorkspaceRoot()}
Auth Token:     ${config.ownerToken ? "(Configured via ~/.devspace/auth.json)" : "(None - public access)"}
============================================================
`);
  });
}

// If executed directly
if (process.argv[1] && process.argv[1].endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js")) {
  main().catch((err) => {
    console.error("[DevSpace 4.0] Fatal startup error:", err);
    process.exit(1);
  });
}
