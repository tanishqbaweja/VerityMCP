import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface ConsoleLogEntry {
  type: string;
  text: string;
  timestamp: number;
}

export interface NetworkEventEntry {
  method: string;
  url: string;
  status?: number;
  failed?: boolean;
  timestamp: number;
}

export interface BrowserSession {
  id: string;
  context: BrowserContext;
  pages: Page[];
  activePageIndex: number;
  currentSnapshotVersion: number;
  elementRefs: Map<string, { selector: string; role?: string; name?: string; text?: string; isChecked?: boolean }>;
  consoleLogs: ConsoleLogEntry[];
  networkEvents: NetworkEventEntry[];
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

    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    return this.browser;
  }

  private wirePageListeners(page: Page, session: BrowserSession) {
    page.on("console", (msg) => {
      session.consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
      if (session.consoleLogs.length > 500) session.consoleLogs.shift();
    });

    page.on("request", (req) => {
      session.networkEvents.push({
        method: req.method(),
        url: req.url(),
        timestamp: Date.now(),
      });
      if (session.networkEvents.length > 500) session.networkEvents.shift();
    });

    page.on("response", (resp) => {
      const match = session.networkEvents.slice(-20).reverse().find((e) => e.url === resp.url());
      if (match) {
        match.status = resp.status();
      }
    });

    page.on("requestfailed", (req) => {
      session.networkEvents.push({
        method: req.method(),
        url: req.url(),
        failed: true,
        timestamp: Date.now(),
      });
    });
  }

  public async getSession(sessionId = "default"): Promise<BrowserSession> {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.pages.length > 0 && !existing.pages[existing.activePageIndex]?.isClosed()) {
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
      pages: [page],
      activePageIndex: 0,
      currentSnapshotVersion: 0,
      elementRefs: new Map(),
      consoleLogs: [],
      networkEvents: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    this.wirePageListeners(page, session);
    this.sessions.set(sessionId, session);
    return session;
  }

  public getActivePage(session: BrowserSession): Page {
    const page = session.pages[session.activePageIndex] || session.pages[0];
    if (!page || page.isClosed()) {
      throw new Error("Active browser tab is closed.");
    }
    return page;
  }

  public async createTab(session: BrowserSession, url?: string): Promise<number> {
    const newPage = await session.context.newPage();
    this.wirePageListeners(newPage, session);
    session.pages.push(newPage);
    session.activePageIndex = session.pages.length - 1;

    if (url) {
      await newPage.goto(url, { waitUntil: "domcontentloaded" });
    }
    return session.activePageIndex;
  }

  public selectTab(session: BrowserSession, index: number): boolean {
    if (index >= 0 && index < session.pages.length && !session.pages[index].isClosed()) {
      session.activePageIndex = index;
      return true;
    }
    return false;
  }

  public async closeTab(session: BrowserSession, index: number): Promise<boolean> {
    if (index >= 0 && index < session.pages.length) {
      const page = session.pages[index];
      await page.close().catch(() => {});
      session.pages.splice(index, 1);
      if (session.activePageIndex >= session.pages.length) {
        session.activePageIndex = Math.max(0, session.pages.length - 1);
      }
      return true;
    }
    return false;
  }

  public async closeSession(sessionId = "default"): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    try {
      for (const p of session.pages) {
        await p.close().catch(() => {});
      }
      await session.context.close().catch(() => {});
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

  public listSessions(): Array<{
    id: string;
    tabsCount: number;
    activeUrl: string;
    createdAt: number;
    lastActiveAt: number;
  }> {
    return Array.from(this.sessions.entries()).map(([id, s]) => {
      const active = s.pages[s.activePageIndex];
      return {
        id,
        tabsCount: s.pages.length,
        activeUrl: active && !active.isClosed() ? active.url() : "about:blank",
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
      };
    });
  }
}

export const browserManager = new BrowserManager();
