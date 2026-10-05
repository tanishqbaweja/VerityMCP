import express, { type Express, type Request, type Response } from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { VerityConfig } from "../types/index.js";
import { OAuthProvider } from "../auth/oauth_provider.js";
import { createVerityMcpServer } from "./mcp_tools.js";
import { workspaceManager } from "../workspace/workspace_manager.js";

import { getMonitorHtml } from "../ui/monitor_html.js";
import { activityStream } from "../observability/activity_stream.js";

export interface VerityAppInstance {
  app: Express;
  config: VerityConfig;
  oauthProvider: OAuthProvider;
  resolveBaseUrl: (req?: Request) => string;
}

export function createVerityApp(config: VerityConfig): VerityAppInstance {
  const app = express();
  const oauthProvider = new OAuthProvider(config);

  const resolveBaseUrl = (req?: Request): string => {
    if (config.publicBaseUrl) {
      return config.publicBaseUrl;
    }
    if (req) {
      const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
      const host = req.headers["x-forwarded-host"] || req.headers.host || `${config.host}:${config.port}`;
      return `${proto}://${host}`;
    }
    return `http://${config.host}:${config.port}`;
  };

  // CORS headers middleware
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Accept, mcp-session-id, x-requested-with"
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Authorization, WWW-Authenticate, Content-Type"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Root info and discovery route
  app.get("/", (req, res) => {
    const baseUrl = resolveBaseUrl(req);
    if (config.ownerToken && !req.headers.authorization) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`
      );
    }
    res.json({
      service: "VerityMCP",
      status: "online",
      version: "1.0.0",
      mcp_endpoint: `${baseUrl}/mcp`,
      health: `${baseUrl}/healthz`,
      monitor: `${baseUrl}/monitor`,
      workspace: workspaceManager.getActiveWorkspaceRoot(),
    });
  });

  // Health check
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      service: "VerityMCP",
      version: "1.0.0",
      workspace: workspaceManager.getActiveWorkspaceRoot(),
      allowedRoots: config.allowedRoots,
    });
  });

  // VerityMCP Activity Monitor UI
  app.get("/monitor", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(getMonitorHtml());
  });

  // Polling endpoint for activity events
  app.get("/activity/events", (req, res) => {
    const cursor = parseInt(req.query.cursor as string, 10) || 0;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const result = activityStream.read({ cursor, limit });
    res.json(result);
  });

  // Server-Sent Events (SSE) live activity stream
  app.get("/activity/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (typeof (res as any).flushHeaders === "function") {
      (res as any).flushHeaders();
    }

    res.write(`data: ${JSON.stringify({ type: "info", title: "Connected to VerityMCP activity stream", timestamp: new Date().toISOString() })}\n\n`);

    const unsubscribe = activityStream.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    req.on("close", () => {
      unsubscribe();
    });
  });

  // Current active action
  app.get("/activity/current", (_req, res) => {
    const current = activityStream.getCurrentAction();
    res.json({
      state: current ? "working" : "idle",
      current_action: current,
    });
  });

  // Mount OAuth Router
  const oauthRouter = oauthProvider.createRouter(() => resolveBaseUrl());
  app.use(oauthRouter);

  // Auth middleware for protected routes
  const authMiddleware = oauthProvider.authMiddleware(() => resolveBaseUrl());

  const jsonParser = express.json({ limit: "50mb" });
  const urlEncodedParser = express.urlencoded({ extended: true, limit: "50mb" });

  // Stateless MCP handler for ChatGPT Web
  const mcpHandler = createMcpHandler(
    () => createVerityMcpServer(config),
    {
      legacy: "stateless",
      onerror: (err) => console.error("[VerityMCP] MCP Handler error:", err),
    }
  );

  const mcpNodeHandler = toNodeHandler(mcpHandler);

  const handleMcpRequest = async (req: Request, res: Response) => {
    let accept = (req.headers.accept as string) || "";
    if (!accept.includes("application/json")) {
      accept = accept ? `${accept}, application/json` : "application/json";
    }
    if (!accept.includes("text/event-stream")) {
      accept = `${accept}, text/event-stream`;
    }
    req.headers.accept = accept;

    if (req.method === "POST" && !req.headers["content-type"]) {
      req.headers["content-type"] = "application/json";
    }

    if (req.body?.params?.clientInfo && !req.body.params.clientInfo.version) {
      req.body.params.clientInfo.version = "1.0";
    }

    try {
      await mcpNodeHandler(req, res, req.body);
    } catch (err: any) {
      console.error("[VerityMCP] Error handling request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  app.all("/mcp", authMiddleware, jsonParser, urlEncodedParser, handleMcpRequest);
  app.post("/", authMiddleware, jsonParser, urlEncodedParser, handleMcpRequest);

  return {
    app,
    config,
    oauthProvider,
    resolveBaseUrl,
  };
}
