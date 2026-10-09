import express, { type Express, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import {
  createMcpHandler,
  isInitializeRequest,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from "@modelcontextprotocol/node";
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

interface LegacyMcpSession {
  transport: NodeStreamableHTTPServerTransport;
  server: ReturnType<typeof createVerityMcpServer>;
  openResponses: number;
  lastActive: number;
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
      "Authorization, Content-Type, Accept, mcp-session-id, MCP-Protocol-Version, x-requested-with"
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Authorization, WWW-Authenticate, Content-Type, mcp-session-id"
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

  // Modern (2026-07-28 envelope) MCP traffic remains per-request.
  // Legacy/2025 ChatGPT traffic is handled by a stateful Streamable HTTP
  // transport below so the server issues a real mcp-session-id.
  const modernMcpHandler = createMcpHandler(
    (ctx) => {
      const requestSessionId =
        ctx.requestInfo?.headers.get("mcp-session-id")?.trim() || undefined;
      return createVerityMcpServer(config, requestSessionId);
    },
    {
      legacy: "reject",
      onerror: (err) => console.error("[VerityMCP] Modern MCP handler error:", err),
    }
  );

  const modernNodeHandler = toNodeHandler(modernMcpHandler);
  const legacySessions = new Map<string, LegacyMcpSession>();
  const LEGACY_SESSION_IDLE_MS = 30 * 60_000;
  const MAX_LEGACY_SESSIONS = 1000;

  const readSessionHeader = (req: Request): string | undefined => {
    const raw = req.headers["mcp-session-id"];
    if (Array.isArray(raw)) return raw[0]?.trim() || undefined;
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  };

  const trackLegacyResponse = (session: LegacyMcpSession, res: Response) => {
    if (!res.socket || res.destroyed) return;
    session.openResponses++;
    res.once("close", () => {
      session.openResponses = Math.max(0, session.openResponses - 1);
      session.lastActive = Date.now();
    });
  };

  const legacySessionSweep = setInterval(() => {
    const cutoff = Date.now() - LEGACY_SESSION_IDLE_MS;
    for (const session of legacySessions.values()) {
      if (session.openResponses === 0 && session.lastActive < cutoff) {
        session.transport.close().catch((err) =>
          console.error("[VerityMCP] Failed closing idle MCP session:", err)
        );
      }
    }
  }, 60_000);
  legacySessionSweep.unref();

  const handleLegacyMcpRequest = async (req: Request, res: Response) => {
    const sessionId = readSessionHeader(req);
    const existing = sessionId ? legacySessions.get(sessionId) : undefined;

    if (existing) {
      existing.lastActive = Date.now();
      trackLegacyResponse(existing, res);
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      if (legacySessions.size >= MAX_LEGACY_SESSIONS) {
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Too many open MCP sessions" },
          id: null,
        });
        return;
      }

      let transport!: NodeStreamableHTTPServerTransport;
      const server = createVerityMcpServer(config);
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          legacySessions.set(newSessionId, {
            transport,
            server,
            openResponses: 0,
            lastActive: Date.now(),
          });
        },
      });

      transport.onerror = (err) =>
        console.error("[VerityMCP] Stateful MCP transport error:", err);
      transport.onclose = () => {
        const closedSessionId = transport.sessionId;
        if (closedSessionId) legacySessions.delete(closedSessionId);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "MCP session not found" },
        id: null,
      });
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid MCP session ID provided" },
      id: null,
    });
  };

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
      const probe = await toWebRequest(req, req.body);
      const legacy = await isLegacyRequest(probe, req.body);
      if (legacy) {
        await handleLegacyMcpRequest(req, res);
      } else {
        await modernNodeHandler(req, res, req.body);
      }
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

  app.all(["/mcp", "/mcp/"], authMiddleware, jsonParser, urlEncodedParser, handleMcpRequest);
  app.post("/", authMiddleware, jsonParser, urlEncodedParser, handleMcpRequest);

  return {
    app,
    config,
    oauthProvider,
    resolveBaseUrl,
  };
}
