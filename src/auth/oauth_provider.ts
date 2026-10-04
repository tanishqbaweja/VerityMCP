import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import type { DevSpaceConfig } from "../types/index.js";

interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  clientName?: string;
  redirectUris: string[];
}

interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  state?: string;
  expiresAt: number;
}

interface AccessToken {
  token: string;
  clientId: string;
  expiresAt: number;
}

export class OAuthProvider {
  private clients = new Map<string, RegisteredClient>();
  private codes = new Map<string, AuthCode>();
  private tokens = new Map<string, AccessToken>();

  constructor(private config: DevSpaceConfig) {}

  private safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  public validateBearer(token: string): boolean {
    if (!token) return false;
    // Direct match with owner token
    if (this.config.ownerToken && this.safeCompare(token, this.config.ownerToken)) {
      return true;
    }
    // Match with issued access tokens
    const record = this.tokens.get(token);
    if (record) {
      if (Date.now() < record.expiresAt) {
        return true;
      }
      this.tokens.delete(token);
    }
    return false;
  }

  public getProtectedResourceMetadata(baseUrl: string) {
    const resourceUrl = `${baseUrl}/mcp`;
    return {
      resource: resourceUrl,
      authorization_servers: [baseUrl],
      scopes_supported: ["devspace"],
      resource_name: "DevSpace 4.0 MCP Server",
    };
  }

  public getAuthServerMetadata(baseUrl: string) {
    return {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: ["devspace"],
    };
  }

  public createRouter(getBaseUrl: () => string): express.Router {
    const router = express.Router();

    // 1. Discovery Routes
    const handleAuthServerMeta = (_req: Request, res: Response) => {
      const baseUrl = getBaseUrl();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.json(this.getAuthServerMetadata(baseUrl));
    };

    const handleProtectedResourceMeta = (_req: Request, res: Response) => {
      const baseUrl = getBaseUrl();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.json(this.getProtectedResourceMetadata(baseUrl));
    };

    router.get("/.well-known/oauth-authorization-server", handleAuthServerMeta);
    router.get("/.well-known/oauth-authorization-server/mcp", handleAuthServerMeta);
    router.get("/.well-known/oauth-protected-resource", handleProtectedResourceMeta);
    router.get("/.well-known/oauth-protected-resource/mcp", handleProtectedResourceMeta);

    // 2. Dynamic Client Registration (RFC 7591)
    router.post("/oauth/register", (req: Request, res: Response) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const body = req.body || {};
      const clientId = body.client_id || `chatgpt-client-${randomBytes(8).toString("hex")}`;
      const clientSecret = body.client_secret || `sec-${randomBytes(16).toString("hex")}`;
      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [body.redirect_uri].filter(Boolean);

      this.clients.set(clientId, {
        clientId,
        clientSecret,
        clientName: body.client_name || "ChatGPT",
        redirectUris,
      });

      res.status(201).json({
        client_id: clientId,
        client_secret: clientSecret,
        client_name: body.client_name || "ChatGPT",
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      });
    });

    // 3. Authorization Endpoint
    router.get("/oauth/authorize", (req: Request, res: Response) => {
      const clientId = String(req.query.client_id || "");
      const redirectUri = String(req.query.redirect_uri || "");
      const state = req.query.state ? String(req.query.state) : undefined;
      const codeChallenge = req.query.code_challenge ? String(req.query.code_challenge) : undefined;
      const codeChallengeMethod = req.query.code_challenge_method ? String(req.query.code_challenge_method) : undefined;

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DevSpace 4.0 Authorization</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #131b2e; padding: 36px; border-radius: 12px; width: 100%; max-width: 420px; box-shadow: 0 10px 25px rgba(0,0,0,0.6); border: 1px solid #1e293b; }
    h2 { margin-top: 0; color: #38bdf8; font-size: 24px; font-weight: 700; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.5; }
    label { display: block; margin-top: 20px; font-size: 13px; font-weight: 600; color: #cbd5e1; }
    input[type="password"] { width: 100%; padding: 12px 14px; border: 1px solid #334155; background: #0b0f19; border-radius: 6px; color: #f8fafc; font-size: 15px; margin-top: 6px; box-sizing: border-box; }
    button { width: 100%; padding: 12px; background: #0284c7; border: none; border-radius: 6px; color: white; font-weight: 600; font-size: 15px; cursor: pointer; margin-top: 24px; transition: background 0.2s; }
    button:hover { background: #0369a1; }
  </style>
</head>
<body>
  <div class="card">
    <h2>DevSpace 4.0</h2>
    <p>Authorize your AI coding agent (ChatGPT / Claude) to access your local engineering workspace with verified tools.</p>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${clientId}">
      <input type="hidden" name="redirect_uri" value="${redirectUri}">
      <input type="hidden" name="state" value="${state || ""}">
      <input type="hidden" name="code_challenge" value="${codeChallenge || ""}">
      <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod || ""}">
      <label for="password">Owner Access Token</label>
      <input type="password" id="password" name="password" placeholder="Enter owner token" required autofocus>
      <button type="submit">Authorize Connection</button>
    </form>
  </div>
</body>
</html>`);
    });

    router.post("/oauth/authorize", express.urlencoded({ extended: true }), (req: Request, res: Response) => {
      const { client_id, redirect_uri, state, code_challenge, code_challenge_method, password } = req.body;

      if (!password || !this.config.ownerToken || !this.safeCompare(password, this.config.ownerToken)) {
        res.status(401).send(`<h2 style="color:red;font-family:sans-serif;padding:20px;">Invalid owner token. Please go back and try again.</h2>`);
        return;
      }

      const code = `code_${randomBytes(16).toString("hex")}`;
      this.codes.set(code, {
        code,
        clientId: client_id || "agent",
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
        state,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      const redirectUrl = new URL(redirect_uri);
      redirectUrl.searchParams.set("code", code);
      if (state) redirectUrl.searchParams.set("state", state);

      res.redirect(302, redirectUrl.href);
    });

    // 4. Token Endpoint
    router.post("/oauth/token", express.urlencoded({ extended: true }), express.json(), (req: Request, res: Response) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const grantType = req.body.grant_type;
      const code = req.body.code;

      if (grantType === "authorization_code") {
        const authCode = this.codes.get(code);
        if (!authCode || Date.now() > authCode.expiresAt) {
          res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired authorization code." });
          return;
        }

        this.codes.delete(code);

        const token = `mcp_${randomBytes(32).toString("hex")}`;
        const expiresIn = 3600 * 24 * 30; // 30 days
        this.tokens.set(token, {
          token,
          clientId: authCode.clientId,
          expiresAt: Date.now() + expiresIn * 1000,
        });

        res.json({
          access_token: token,
          token_type: "Bearer",
          expires_in: expiresIn,
          scope: "devspace",
        });
        return;
      }

      res.status(400).json({ error: "unsupported_grant_type" });
    });

    return router;
  }

  public authMiddleware(getBaseUrl: () => string) {
    return (req: Request, res: Response, next: NextFunction) => {
      // If no owner token configured, allow all
      if (!this.config.ownerToken) {
        return next();
      }

      const authHeader = req.headers.authorization;
      if (!authHeader) {
        const baseUrl = getBaseUrl();
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`
        );
        res.status(401).json({
          error: "unauthorized",
          error_description: "Missing Bearer Authorization header.",
        });
        return;
      }

      const [scheme, token] = authHeader.split(" ");
      if (scheme?.toLowerCase() !== "bearer" || !token) {
        res.status(401).json({
          error: "invalid_token",
          error_description: "Invalid token format. Expected Bearer <token>.",
        });
        return;
      }

      if (!this.validateBearer(token)) {
        res.status(403).json({
          error: "forbidden",
          error_description: "Invalid or expired access token.",
        });
        return;
      }

      next();
    };
  }
}
