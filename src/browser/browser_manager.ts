import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";

export interface BrowserSession {
  id: string;
  context: BrowserContext;
  page: Page;
  currentSnapshotVersion: number;
  elementRefs: Map<string, { selector: string; role?: string; name?: string; text?: string; isChecked?: boolean }>;
  createdAt: number;
  lastActiveAt: number;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private sessions = new Map<string, BrowserSession>();

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    // Launch Chromium with sandbox disabled for Windows execution
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    return this.browser;
  }

  public async getSession(sessionId = "default"): Promise<BrowserSession> {
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.page.isClosed()) {
      existing.lastActiveAt = Date.now();
      return existing;
    }

    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) DevSpace/4.0 AutomatedAgent",
    });

    const page = await context.newPage();

    const session: BrowserSession = {
      id: sessionId,
      context,
      page,
      currentSnapshotVersion: 0,
      elementRefs: new Map(),
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  public async closeSession(sessionId = "default"): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    try {
      await session.page.close();
      await session.context.close();
    } catch {}

    this.sessions.delete(sessionId);
    return true;
  }

  public async closeAll(): Promise<void> {
    for (const [id] of this.sessions) {
      await this.closeSession(id);
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
    }
  }

  public listSessions(): Array<{ id: string; url: string; createdAt: number; lastActiveAt: number }> {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      id,
      url: s.page.url(),
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
    }));
  }
}

export const browserManager = new BrowserManager();
