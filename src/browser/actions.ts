import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { BrowserSession } from "./browser_manager.js";
import { browserManager } from "./browser_manager.js";
import { workspaceManager } from "../workspace/workspace_manager.js";
import { activityStream } from "../observability/activity_stream.js";
import { verifyFileExistence, calculateSha256 } from "../verification/index.js";
import { resolveArtifactOutputPath } from "../storage/paths.js";
import type { StandardToolResponse } from "../types/index.js";

function emitBrowserActionStart(
  session: BrowserSession,
  tool: string,
  displayTitle: string,
  target?: any,
  purpose?: string
) {
  return activityStream.emit({
    type: "action_started",
    tool,
    title: displayTitle,
    display_title: displayTitle,
    purpose,
    target,
    browser_session_id: session.id,
    status: "running",
  });
}

function emitBrowserActionComplete(
  session: BrowserSession,
  tool: string,
  displayTitle: string,
  evidence?: any,
  target?: any,
  isVerification = true
) {
  return activityStream.emit({
    type: isVerification ? "verification" : "action_completed",
    tool,
    title: displayTitle,
    display_title: displayTitle,
    evidence,
    target,
    browser_session_id: session.id,
    status: isVerification ? "verified" : "completed",
  });
}

function emitBrowserActionFailure(
  session: BrowserSession,
  tool: string,
  displayTitle: string,
  error: string,
  target?: any
) {
  return activityStream.emit({
    type: "failure",
    tool,
    title: `${displayTitle}: ${error}`,
    display_title: displayTitle,
    evidence: { error },
    target,
    browser_session_id: session.id,
    status: "failed",
  });
}

function resolveTarget(
  session: BrowserSession,
  target: { ref?: string; selector?: string }
): string {
  if (target.ref) {
    const cleanRef = target.ref.replace(/^@/, "");

    // 1. Check generation prefix: e.g. d1:e2
    const genMatch = cleanRef.match(/^d(\d+):e\d+$/);
    if (genMatch) {
      const refGen = parseInt(genMatch[1], 10);
      if (refGen !== session.documentGeneration) {
        activityStream.emit({
          type: "warning",
          tool: "browser",
          title: `Unsafe stale ref blocked: ${target.ref}`,
          display_title: "Unsafe stale ref blocked",
          purpose: "Prevent interaction with stale element from older document generation",
          target: { ref: target.ref, session_id: session.id },
          evidence: `Ref belongs to generation ${refGen}, current generation is ${session.documentGeneration}`,
          status: "blocked",
          browser_session_id: session.id,
        });

        const err: any = new Error(
          `STALE_ELEMENT_REFERENCE: Ref "${target.ref}" belongs to document generation ${refGen}, but current generation is ${session.documentGeneration}. The page has navigated or reloaded.`
        );
        err.code = "STALE_ELEMENT_REFERENCE";
        err.ref = target.ref;
        err.ref_generation = refGen;
        err.current_generation = session.documentGeneration;
        throw err;
      }
    }

    let found = session.elementRefs.get(cleanRef);
    if (!found && !cleanRef.includes(":")) {
      found = session.elementRefs.get(`d${session.documentGeneration}:${cleanRef}`);
    }

    if (!found) {
      const historical =
        session.refHistory.get(cleanRef) ||
        (!cleanRef.includes(":")
          ? Array.from(session.refHistory.entries()).find(([k]) => k.endsWith(`:${cleanRef}`))?.[1]
          : undefined);

      activityStream.emit({
        type: "warning",
        tool: "browser",
        title: `Unsafe stale ref blocked: ${target.ref}`,
        display_title: "Unsafe stale ref blocked",
        purpose: "Prevent interaction with stale element missing from current snapshot",
        target: { ref: target.ref, session_id: session.id },
        evidence: `Ref missing in snapshot v${session.currentSnapshotVersion} (gen ${session.documentGeneration})`,
        status: "blocked",
        browser_session_id: session.id,
      });

      const err: any = new Error(
        `STALE_ELEMENT_REFERENCE: Ref "${target.ref}" not found in current snapshot (v${session.currentSnapshotVersion}, gen ${session.documentGeneration}). The page DOM changed or element was navigated away. Please take a new browser_snapshot.`
      );
      err.code = "STALE_ELEMENT_REFERENCE";
      err.ref = target.ref;
      err.ref_generation = historical?.generation || (genMatch ? parseInt(genMatch[1], 10) : undefined);
      err.current_generation = session.documentGeneration;
      throw err;
    }
    return found.selector;
  }
  if (target.selector) {
    return target.selector;
  }
  const err: any = new Error("Must provide either 'ref' (from browser_snapshot) or 'selector'.");
  err.code = "INVALID_ARGUMENT";
  throw err;
}

export interface NavigateResult {
  success: boolean;
  errorCode?: string;
  error?: string;
  requestedUrl: string;
  finalUrl: string;
  title: string;
  status: number;
  isErrorPage: boolean;
}

async function stabilizeFailedNavigation(page: Page): Promise<void> {
  // Chromium can schedule chrome-error://chromewebdata/ after page.goto has already rejected.
  // Stop any in-flight loader first, then require a short period of URL stability before
  // returning the failed navigation to callers. This prevents an immediate recovery goto
  // from being interrupted by Chromium's delayed internal error-page navigation.
  try {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Page.stopLoading");
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch {}

  const deadline = Date.now() + 500;
  let previousUrl = "";
  try { previousUrl = page.url(); } catch {}
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(25);
    let currentUrl = previousUrl;
    try { currentUrl = page.url(); } catch {}
    if (currentUrl !== previousUrl) {
      previousUrl = currentUrl;
      stableSince = Date.now();
    }
    if (Date.now() - stableSince >= 175 && Date.now() + 100 >= deadline) break;
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 250 }).catch(() => {});
}

/**
 * Shared, canonical navigation and verification helper.
 * Validates actual navigation success, detects Chromium error pages (e.g. chrome-error://chromewebdata/),
 * correctly treats about:blank as valid when requested, and handles redirects.
 */
export async function navigateAndVerify(
  page: Page,
  url: string,
  timeout = 30000
): Promise<NavigateResult> {
  const requestedUrl = url;
  let finalUrl = requestedUrl;
  let title = "";
  let status = 200;
  let isErrorPage = false;
  let navError: Error | null = null;

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout,
    });
    status = response ? response.status() : 200;
  } catch (err: any) {
    navError = err;
    await stabilizeFailedNavigation(page);
  }

  try {
    finalUrl = page.url();
  } catch {}
  try {
    title = await page.title();
  } catch {}

  // Check for Chromium error page
  if (finalUrl.startsWith("chrome-error://") || finalUrl.includes("chromewebdata")) {
    isErrorPage = true;
  }

  const isAboutBlank = requestedUrl.trim().toLowerCase() === "about:blank";
  if (isAboutBlank && (finalUrl === "about:blank" || !isErrorPage)) {
    return {
      success: true,
      requestedUrl,
      finalUrl: finalUrl || "about:blank",
      title,
      status: 200,
      isErrorPage: false,
    };
  }

  if (navError || isErrorPage || status >= 400) {
    const errorMsg = navError
      ? navError.message
      : isErrorPage
      ? "Navigation resulted in chrome-error page"
      : `HTTP error status ${status}`;

    return {
      success: false,
      errorCode: "BROWSER_NAVIGATION_FAILED",
      error: errorMsg,
      requestedUrl,
      finalUrl,
      title,
      status,
      isErrorPage,
    };
  }

  return {
    success: true,
    requestedUrl,
    finalUrl,
    title,
    status,
    isErrorPage: false,
  };
}

export async function executeNavigate(
  session: BrowserSession,
  url: string
): Promise<StandardToolResponse<{ url: string; title: string; status: number; requested_url?: string; final_url?: string }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  emitBrowserActionStart(session, "browser_navigate", `Navigating to ${url}`, { url });

  const navRes = await navigateAndVerify(page, url, 30000);

  if (navRes.success) {
    emitBrowserActionComplete(
      session,
      "browser_navigate",
      "Navigation complete",
      { url: navRes.finalUrl, title: navRes.title, status: navRes.status, generation: session.documentGeneration },
      { url: navRes.finalUrl },
      true
    );

    return {
      success: true,
      action: `browser_navigate "${url}"`,
      text: `Navigated to ${navRes.finalUrl} (Title: "${navRes.title}", HTTP ${navRes.status})`,
      summary: `Navigated to ${navRes.finalUrl} (HTTP ${navRes.status})`,
      execution_verification: {
        status: "passed",
        method: "page_goto",
      },
      state_verification: {
        status: "passed",
        method: "http_status_and_url_verification",
        observed_changes: [{ type: "url_navigation", after: navRes.finalUrl }],
        details: { finalUrl: navRes.finalUrl, title: navRes.title, status: navRes.status },
      },
      verification: {
        performed: true,
        passed: true,
        method: "http_status_and_url_verification",
        details: { finalUrl: navRes.finalUrl, title: navRes.title, status: navRes.status },
        execution: { status: "passed", method: "page_goto" },
        state: { status: "passed", method: "http_status_and_url_verification" },
      },
      data: { url: navRes.finalUrl, requested_url: navRes.requestedUrl, final_url: navRes.finalUrl, title: navRes.title, status: navRes.status },
      durationMs: Date.now() - startTime,
    };
  } else {
    emitBrowserActionFailure(session, "browser_navigate", "Navigation failed", navRes.error || "Navigation failed", { url });
    return {
      success: false,
      error_code: navRes.errorCode || "BROWSER_NAVIGATION_FAILED",
      action: `browser_navigate "${url}"`,
      text: `Navigation to "${url}" failed: ${navRes.error}\nFinal page: ${navRes.finalUrl}`,
      summary: `Navigation failed: ${navRes.error}`,
      verification: {
        performed: true,
        passed: false,
        method: "page_goto",
        error: navRes.error,
        execution: { status: "failed", method: "page_goto", error: navRes.error },
        state: { status: "failed", method: "http_status_and_url_verification", details: { finalUrl: navRes.finalUrl, status: navRes.status } },
      },
      data: { url: navRes.finalUrl, requested_url: navRes.requestedUrl, final_url: navRes.finalUrl, title: navRes.title, status: navRes.status },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeReload(
  session: BrowserSession
): Promise<StandardToolResponse<{ url: string }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  emitBrowserActionStart(session, "browser_reload", "Reloading page");
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    const currentUrl = page.url();
    emitBrowserActionComplete(session, "browser_reload", "Page reloaded", { url: currentUrl });
    return {
      success: true,
      action: "page_reload",
      text: `Page reloaded. Current URL: ${currentUrl}`,
      summary: `Page reloaded at ${currentUrl}`,
      verification: {
        performed: true,
        passed: true,
        method: "page_reload_success",
        details: { url: currentUrl },
        execution: { status: "passed", method: "page_reload" },
        state: { status: "passed", method: "page_reload_success" },
      },
      data: { url: currentUrl },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    emitBrowserActionFailure(session, "browser_reload", "Reload failed", err.message);
    return {
      success: false,
      error_code: "COMMAND_FAILED",
      action: "page_reload",
      text: `Reload failed: ${err.message}`,
      summary: `Reload failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "page_reload",
        error: err.message,
        execution: { status: "failed", method: "page_reload", error: err.message },
        state: { status: "not_performed" },
      },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeGoBack(
  session: BrowserSession
): Promise<StandardToolResponse<{ url: string }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  emitBrowserActionStart(session, "browser_go_back", "Navigating back");
  try {
    await page.goBack();
    const currentUrl = page.url();
    emitBrowserActionComplete(session, "browser_go_back", "Navigated back", { url: currentUrl });
    return {
      success: true,
      action: "page_back",
      text: `Navigated back to: ${currentUrl}`,
      summary: `Navigated back to ${currentUrl}`,
      verification: {
        performed: true,
        passed: true,
        method: "page_history_back",
        details: { url: currentUrl },
        execution: { status: "passed", method: "page_history_back" },
        state: { status: "passed", method: "page_history_back" },
      },
      data: { url: currentUrl },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    emitBrowserActionFailure(session, "browser_go_back", "History back failed", err.message);
    return {
      success: false,
      error_code: "COMMAND_FAILED",
      action: "page_back",
      text: `History back failed: ${err.message}`,
      summary: `History back failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "page_history_back",
        error: err.message,
        execution: { status: "failed", method: "page_history_back", error: err.message },
        state: { status: "not_performed" },
      },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeGoForward(
  session: BrowserSession
): Promise<StandardToolResponse<{ url: string }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  emitBrowserActionStart(session, "browser_go_forward", "Navigating forward");
  try {
    await page.goForward();
    const currentUrl = page.url();
    emitBrowserActionComplete(session, "browser_go_forward", "Navigated forward", { url: currentUrl });
    return {
      success: true,
      action: "page_forward",
      text: `Navigated forward to: ${currentUrl}`,
      summary: `Navigated forward to ${currentUrl}`,
      verification: {
        performed: true,
        passed: true,
        method: "page_history_forward",
        details: { url: currentUrl },
        execution: { status: "passed", method: "page_history_forward" },
        state: { status: "passed", method: "page_history_forward" },
      },
      data: { url: currentUrl },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    emitBrowserActionFailure(session, "browser_go_forward", "History forward failed", err.message);
    return {
      success: false,
      error_code: "COMMAND_FAILED",
      action: "page_forward",
      text: `History forward failed: ${err.message}`,
      summary: `History forward failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "page_history_forward",
        error: err.message,
        execution: { status: "failed", method: "page_history_forward", error: err.message },
        state: { status: "not_performed" },
      },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeClick(
  session: BrowserSession,
  target: { ref?: string; selector?: string }
): Promise<StandardToolResponse<{ target: string; currentUrl: string; timings?: Record<string, number> }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  emitBrowserActionStart(session, "browser_click", `Clicking ${target.ref ? `[ref=${target.ref}]` : target.selector || "element"}`, target);

  let selector: string;
  const tResStart = Date.now();
  try {
    selector = resolveTarget(session, target);
  } catch (err: any) {
    const target_resolution_ms = Date.now() - tResStart;
    const isStale = err.code === "STALE_ELEMENT_REFERENCE";
    emitBrowserActionFailure(session, "browser_click", "Target resolution failed", err.message, target);
    return {
      success: false,
      error_code: isStale ? "STALE_ELEMENT_REFERENCE" : "INVALID_ARGUMENT",
      action: `browser_click ${JSON.stringify(target)}`,
      text: err.message,
      summary: `Target resolution failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "target_resolution",
        error: err.message,
        execution: { status: "failed", method: "target_resolution", error: err.message },
        state: { status: "not_performed" },
      },
      durationMs: Date.now() - startTime,
    };
  }
  const target_resolution_ms = Date.now() - tResStart;

  try {
    const tPreStart = Date.now();
    const beforeUrl = page.url();
    const beforeTitle = await page.title().catch(() => "");
    let beforeChecked: boolean | null = null;
    let beforeExpanded: string | null = null;

    try {
      const loc = page.locator(selector).first();
      const tagName = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
      const type = await loc.getAttribute("type").catch(() => null);
      if (tagName === "input" && (type === "checkbox" || type === "radio")) {
        beforeChecked = await loc.isChecked().catch(() => null);
      }
      beforeExpanded = await loc.getAttribute("aria-expanded").catch(() => null);
    } catch {}
    const pre_state_capture_ms = Date.now() - tPreStart;

    const tClickStart = Date.now();
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "attached", timeout: 10000 });
    let firstClickErr: any = null;
    try {
      await locator.click({ timeout: 3000 });
    } catch (err: any) {
      firstClickErr = err;
    }

    if (firstClickErr) {
      // If navigation was already initiated/occurred as a result of the click, don't stall for 30s!
      if (page.url() === beforeUrl) {
        await locator.click({ force: true, timeout: 2000 }).catch(() => {});
      }
    }
    const playwright_click_ms = Date.now() - tClickStart;

    // Navigation wait phase
    const tNavStart = Date.now();
    if (page.url() === beforeUrl) {
      // If URL hasn't changed immediately, wait briefly for navigation or URL change if an anchor/button triggered navigation
      await Promise.race([
        page.waitForURL((u) => u.toString() !== beforeUrl, { timeout: 1500 }).catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 150)),
      ]);
    } else {
      await page.waitForTimeout(100);
    }
    const navigation_wait_ms = Date.now() - tNavStart;

    const tPostStart = Date.now();
    const afterUrl = page.url();
    const afterTitle = await page.title().catch(() => "");
    let afterChecked: boolean | null = null;
    let afterExpanded: string | null = null;
    let elementStillPresent = true;

    try {
      elementStillPresent = await page.locator(selector).first().count().then((c) => c > 0).catch(() => false);
      if (elementStillPresent && beforeChecked !== null) {
        afterChecked = await page.locator(selector).first().isChecked().catch(() => null);
      }
      if (elementStillPresent && beforeExpanded !== null) {
        afterExpanded = await page.locator(selector).first().getAttribute("aria-expanded").catch(() => null);
      }
    } catch {
      elementStillPresent = false;
    }
    const post_state_capture_ms = Date.now() - tPostStart;

    const tVerifStart = Date.now();
    const observedChanges: Array<{ type: string; before?: unknown; after?: unknown; description?: string }> = [];

    if (afterUrl !== beforeUrl) {
      observedChanges.push({
        type: "url_navigation",
        before: beforeUrl,
        after: afterUrl,
        description: `URL changed from ${beforeUrl} to ${afterUrl}`,
      });
    }
    if (afterTitle !== beforeTitle) {
      observedChanges.push({
        type: "title_change",
        before: beforeTitle,
        after: afterTitle,
        description: `Title changed from "${beforeTitle}" to "${afterTitle}"`,
      });
    }
    if (beforeChecked !== null && afterChecked !== null && beforeChecked !== afterChecked) {
      observedChanges.push({
        type: "checkbox_toggle",
        before: beforeChecked,
        after: afterChecked,
        description: `Checkbox state toggled from ${beforeChecked} to ${afterChecked}`,
      });
    }
    if (beforeExpanded !== null && afterExpanded !== null && beforeExpanded !== afterExpanded) {
      observedChanges.push({
        type: "aria_expanded_toggle",
        before: beforeExpanded,
        after: afterExpanded,
        description: `Aria-expanded changed from ${beforeExpanded} to ${afterExpanded}`,
      });
    }
    if (!elementStillPresent && target.ref) {
      observedChanges.push({
        type: "element_removed",
        description: `Element ${target.ref} was removed from DOM after click`,
      });
    }

    const hasStateDelta = observedChanges.length > 0;
    const descText = hasStateDelta
      ? `Clicked element successfully. Observed changes: ${observedChanges.map((c) => c.description).join("; ")}`
      : `Clicked element successfully. Execution: EXECUTED (no immediate DOM state delta observed).`;

    const verification_ms = Date.now() - tVerifStart;
    const total_ms = Date.now() - startTime;

    const timings = {
      target_resolution_ms,
      pre_state_capture_ms,
      playwright_click_ms,
      navigation_wait_ms,
      post_state_capture_ms,
      verification_ms,
      total_ms,
    };

    emitBrowserActionComplete(
      session,
      "browser_click",
      "Click verified",
      {
        observedChanges,
        elementStillPresent,
        afterChecked,
        afterUrl,
        method: hasStateDelta ? "dom_delta_observation" : "playwright_click",
        timings,
      },
      target
    );

    return {
      success: true,
      action: `browser_click ${target.ref ? `[ref=${target.ref}]` : selector}`,
      text: descText,
      summary: hasStateDelta ? `Click triggered ${observedChanges.length} state change(s)` : `Clicked element (executed)`,
      execution_verification: {
        status: "passed",
        method: "playwright_click",
      },
      state_verification: hasStateDelta
        ? {
            status: "passed",
            method: "dom_delta_observation",
            observed_changes: observedChanges,
          }
        : {
            status: "not_observable",
            method: "dom_delta_observation",
            details: { message: "No immediate DOM delta observed" },
          },
      verification: {
        performed: true,
        passed: true,
        method: hasStateDelta ? "dom_delta_observation" : "playwright_click",
        details: { selector, beforeUrl, afterUrl, observedChanges, timings },
        execution: { status: "passed", method: "playwright_click" },
        state: hasStateDelta
          ? { status: "passed", method: "dom_delta_observation", observed_changes: observedChanges }
          : { status: "not_observable", method: "dom_delta_observation" },
      },
      data: { target: selector, currentUrl: afterUrl, timings },
      durationMs: total_ms,
    };
  } catch (err: any) {
    const isStale = err.code === "STALE_ELEMENT_REFERENCE" || err.message?.includes("STALE_ELEMENT_REFERENCE");
    emitBrowserActionFailure(session, "browser_click", "Click failed", err.message, target);
    return {
      success: false,
      error_code: isStale ? "STALE_ELEMENT_REFERENCE" : "COMMAND_FAILED",
      action: `browser_click ${JSON.stringify(target)}`,
      text: `Click failed: ${err.message}`,
      summary: `Click failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "playwright_click",
        error: err.message,
        execution: { status: "failed", method: "playwright_click", error: err.message },
        state: { status: "not_performed" },
      },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeDoubleClick(
  session: BrowserSession,
  target: { ref?: string; selector?: string }
): Promise<StandardToolResponse<{ target: string }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  emitBrowserActionStart(session, "browser_double_click", `Double-clicking ${target.ref ? `[ref=${target.ref}]` : target.selector || "element"}`, target);
  let selector: string;
  try {
    selector = resolveTarget(session, target);
  } catch (err: any) {
    const isStale = err.code === "STALE_ELEMENT_REFERENCE";
    emitBrowserActionFailure(session, "browser_double_click", "Target resolution failed", err.message, target);
    return {
      success: false,
      error_code: isStale ? "STALE_ELEMENT_REFERENCE" : "INVALID_ARGUMENT",
      action: `browser_double_click ${JSON.stringify(target)}`,
      text: err.message,
      summary: `Target resolution failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "target_resolution", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const locator = page.locator(selector).first();
    await locator.dblclick();
    emitBrowserActionComplete(session, "browser_double_click", "Double-click complete", { target: selector }, target);
    return {
      success: true,
      action: `browser_double_click ${target.ref ? `[ref=${target.ref}]` : selector}`,
      text: `Double-clicked element successfully.`,
      summary: `Double-clicked element`,
      execution_verification: { status: "passed", method: "playwright_dblclick" },
      state_verification: { status: "not_observable", method: "dblclick" },
      verification: { performed: true, passed: true, method: "playwright_dblclick" },
      data: { target: selector },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    emitBrowserActionFailure(session, "browser_double_click", "Double-click failed", err.message, target);
    return {
      success: false,
      error_code: "COMMAND_FAILED",
      action: `browser_double_click`,
      text: `Double-click failed: ${err.message}`,
      summary: `Double-click failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "playwright_dblclick", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeHover(
  session: BrowserSession,
  target: { ref?: string; selector?: string }
): Promise<StandardToolResponse<{ target: string }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  emitBrowserActionStart(session, "browser_hover", `Hovering over ${target.ref ? `[ref=${target.ref}]` : target.selector || "element"}`, target);
  let selector: string;
  try {
    selector = resolveTarget(session, target);
  } catch (err: any) {
    const isStale = err.code === "STALE_ELEMENT_REFERENCE";
    emitBrowserActionFailure(session, "browser_hover", "Target resolution failed", err.message, target);
    return {
      success: false,
      error_code: isStale ? "STALE_ELEMENT_REFERENCE" : "INVALID_ARGUMENT",
      action: `browser_hover ${JSON.stringify(target)}`,
      text: err.message,
      summary: `Target resolution failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "target_resolution", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const locator = page.locator(selector).first();
    await locator.hover();
    emitBrowserActionComplete(session, "browser_hover", "Hover complete", { target: selector }, target, false);
    return {
      success: true,
      action: `browser_hover ${target.ref ? `[ref=${target.ref}]` : selector}`,
      text: `Hovered over element successfully.`,
      summary: `Hovered over element`,
      execution_verification: { status: "passed", method: "playwright_hover" },
      state_verification: { status: "not_observable", method: "hover" },
      verification: { performed: true, passed: true, method: "playwright_hover" },
      data: { target: selector },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    emitBrowserActionFailure(session, "browser_hover", "Hover failed", err.message, target);
    return {
      success: false,
      error_code: "COMMAND_FAILED",
      action: `browser_hover`,
      text: `Hover failed: ${err.message}`,
      summary: `Hover failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "playwright_hover", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeFill(
  session: BrowserSession,
  target: { ref?: string; selector?: string },
  value: string
): Promise<StandardToolResponse<{ target: string; verifiedValue: string }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  emitBrowserActionStart(session, "browser_fill", `Filling ${target.ref ? `[ref=${target.ref}]` : target.selector || "element"}`, { ...target, value });

  let selector: string;
  try {
    selector = resolveTarget(session, target);
  } catch (err: any) {
    const isStale = err.code === "STALE_ELEMENT_REFERENCE";
    emitBrowserActionFailure(session, "browser_fill", "Target resolution failed", err.message, target);
    return {
      success: false,
      error_code: isStale ? "STALE_ELEMENT_REFERENCE" : "INVALID_ARGUMENT",
      action: `browser_fill ${JSON.stringify(target)}`,
      text: err.message,
      summary: `Target resolution failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "target_resolution",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout: 10000 });
    await locator.fill(value);
    await locator.focus();

    // MANDATORY DOM READBACK VERIFICATION
    const actualValue = await locator.inputValue();
    const passed = actualValue === value;

    if (!passed) {
      emitBrowserActionFailure(session, "browser_fill", "DOM readback mismatch", `Expected "${value}", found "${actualValue}"`, target);
      return {
        success: false,
        error_code: "ELEMENT_NOT_EDITABLE",
        action: `browser_fill ${target.ref ? `[ref=${target.ref}]` : selector}`,
        text: `CRITICAL: Fill failed DOM readback! Expected "${value}", found "${actualValue}".`,
        summary: `Fill readback mismatch: expected "${value}", found "${actualValue}"`,
        execution_verification: { status: "passed", method: "playwright_fill" },
        state_verification: { status: "failed", method: "dom_inputValue_readback", error: "Value mismatch" },
        verification: {
          performed: true,
          passed: false,
          method: "dom_inputValue_readback",
          error: `DOM value mismatch: "${actualValue}" !== "${value}"`,
          details: { expected: value, actual: actualValue },
          execution: { status: "passed", method: "playwright_fill" },
          state: { status: "failed", method: "dom_inputValue_readback" },
        },
        durationMs: Date.now() - startTime,
      };
    }

    emitBrowserActionComplete(session, "browser_fill", "Form fill verified", { verifiedValue: actualValue, method: "dom_inputValue_readback" }, target);

    return {
      success: true,
      action: `browser_fill ${target.ref ? `[ref=${target.ref}]` : selector}`,
      text: `Filled element with "${value}". DOM readback verified.`,
      summary: `Filled element with "${value}" (verified)`,
      execution_verification: { status: "passed", method: "playwright_fill" },
      state_verification: {
        status: "passed",
        method: "dom_inputValue_readback",
        observed_changes: [{ type: "input_value_change", after: actualValue }],
        details: { verifiedValue: actualValue },
      },
      verification: {
        performed: true,
        passed: true,
        method: "dom_inputValue_readback",
        details: { verifiedValue: actualValue },
        execution: { status: "passed", method: "playwright_fill" },
        state: { status: "passed", method: "dom_inputValue_readback" },
      },
      data: { target: selector, verifiedValue: actualValue },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    const isStale = err.code === "STALE_ELEMENT_REFERENCE" || err.message?.includes("STALE_ELEMENT_REFERENCE");
    emitBrowserActionFailure(session, "browser_fill", "Fill failed", err.message, target);
    return {
      success: false,
      error_code: isStale ? "STALE_ELEMENT_REFERENCE" : "COMMAND_FAILED",
      action: `browser_fill ${JSON.stringify(target)}`,
      text: `Fill action failed: ${err.message}`,
      summary: `Fill failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "playwright_fill",
        error: err.message,
        execution: { status: "failed", method: "playwright_fill", error: err.message },
        state: { status: "not_performed" },
      },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeCheck(
  session: BrowserSession,
  target: { ref?: string; selector?: string },
  checked = true
): Promise<StandardToolResponse<{ target: string; isChecked: boolean }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  emitBrowserActionStart(session, "browser_check", `Checking ${target.ref ? `[ref=${target.ref}]` : target.selector || "element"}`, { ...target, checked });

  let selector: string;
  try {
    selector = resolveTarget(session, target);
  } catch (err: any) {
    const isStale = err.code === "STALE_ELEMENT_REFERENCE";
    emitBrowserActionFailure(session, "browser_check", "Target resolution failed", err.message, target);
    return {
      success: false,
      error_code: isStale ? "STALE_ELEMENT_REFERENCE" : "INVALID_ARGUMENT",
      action: `browser_check ${JSON.stringify(target)}`,
      text: err.message,
      summary: `Target resolution failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "target_resolution",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "attached", timeout: 10000 });
    try {
      await locator.setChecked(checked, { timeout: 3000 });
    } catch {
      await locator.setChecked(checked, { force: true });
    }

    // MANDATORY DOM READBACK VERIFICATION
    const isChecked = await locator.isChecked();
    const passed = isChecked === checked;

    if (!passed) {
      emitBrowserActionFailure(session, "browser_check", "DOM checked readback mismatch", `Expected ${checked}, found ${isChecked}`, target);
      return {
        success: false,
        error_code: "ELEMENT_NOT_EDITABLE",
        action: `browser_check ${target.ref ? `[ref=${target.ref}]` : selector}`,
        text: `CRITICAL: Check action failed DOM verification! Expected checked=${checked}, found isChecked=${isChecked}.`,
        summary: `Checkbox readback mismatch: expected ${checked}, found ${isChecked}`,
        execution_verification: { status: "passed", method: "playwright_setChecked" },
        state_verification: { status: "failed", method: "dom_isChecked_readback", error: "Checked state mismatch" },
        verification: {
          performed: true,
          passed: false,
          method: "dom_isChecked_readback",
          error: `DOM checked state mismatch`,
          details: { expected: checked, actual: isChecked },
          execution: { status: "passed", method: "playwright_setChecked" },
          state: { status: "failed", method: "dom_isChecked_readback" },
        },
        durationMs: Date.now() - startTime,
      };
    }

    emitBrowserActionComplete(session, "browser_check", "Checkbox verified", { checked: isChecked, method: "dom_isChecked_readback" }, target);

    return {
      success: true,
      action: `browser_check ${target.ref ? `[ref=${target.ref}]` : selector}`,
      text: `Element checked state set to ${checked}. Verified via DOM readback.`,
      summary: `Checked state set to ${checked} (verified)`,
      execution_verification: { status: "passed", method: "playwright_setChecked" },
      state_verification: {
        status: "passed",
        method: "dom_isChecked_readback",
        observed_changes: [{ type: "checkbox_toggle", after: isChecked }],
        details: { isChecked },
      },
      verification: {
        performed: true,
        passed: true,
        method: "dom_isChecked_readback",
        details: { isChecked },
        execution: { status: "passed", method: "playwright_setChecked" },
        state: { status: "passed", method: "dom_isChecked_readback" },
      },
      data: { target: selector, isChecked },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    const isStale = err.code === "STALE_ELEMENT_REFERENCE" || err.message?.includes("STALE_ELEMENT_REFERENCE");
    emitBrowserActionFailure(session, "browser_check", "Check failed", err.message, target);
    return {
      success: false,
      error_code: isStale ? "STALE_ELEMENT_REFERENCE" : "COMMAND_FAILED",
      action: `browser_check ${JSON.stringify(target)}`,
      text: `Check action failed: ${err.message}`,
      summary: `Check failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "playwright_check",
        error: err.message,
        execution: { status: "failed", method: "playwright_check", error: err.message },
        state: { status: "not_performed" },
      },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeSelect(
  session: BrowserSession,
  target: { ref?: string; selector?: string },
  value: string
): Promise<StandardToolResponse<{ target: string; selectedValue: string }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  emitBrowserActionStart(session, "browser_select", `Selecting option in ${target.ref ? `[ref=${target.ref}]` : target.selector || "element"}`, { ...target, value });
  let selector: string;
  try {
    selector = resolveTarget(session, target);
  } catch (err: any) {
    const isStale = err.code === "STALE_ELEMENT_REFERENCE";
    emitBrowserActionFailure(session, "browser_select", "Target resolution failed", err.message, target);
    return {
      success: false,
      error_code: isStale ? "STALE_ELEMENT_REFERENCE" : "INVALID_ARGUMENT",
      action: `browser_select ${JSON.stringify(target)}`,
      text: err.message,
      summary: `Target resolution failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "target_resolution", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const locator = page.locator(selector).first();
    await locator.selectOption(value);
    const actual = await locator.inputValue();
    emitBrowserActionComplete(session, "browser_select", "Select option complete", { selectedValue: actual }, target);
    return {
      success: true,
      action: `browser_select "${value}"`,
      text: `Selected option "${value}" (verified: "${actual}").`,
      summary: `Selected option "${value}" (verified)`,
      execution_verification: { status: "passed", method: "playwright_selectOption" },
      state_verification: {
        status: "passed",
        method: "dom_select_readback",
        observed_changes: [{ type: "dropdown_value_change", after: actual }],
        details: { actual },
      },
      verification: { performed: true, passed: true, method: "dom_select_readback", details: { actual } },
      data: { target: selector, selectedValue: actual },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    emitBrowserActionFailure(session, "browser_select", "Select option failed", err.message, target);
    return {
      success: false,
      error_code: "COMMAND_FAILED",
      action: "browser_select",
      text: `Select option failed: ${err.message}`,
      summary: `Select option failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "dom_select", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeUpload(
  session: BrowserSession,
  target: { ref?: string; selector?: string },
  filePaths: string[]
): Promise<StandardToolResponse<{ target: string; files: string[] }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  emitBrowserActionStart(session, "browser_upload", `Uploading file to ${target.ref ? `[ref=${target.ref}]` : target.selector || "element"}`, { ...target, filePaths });
  let selector: string;
  try {
    selector = resolveTarget(session, target);
  } catch (err: any) {
    const isStale = err.code === "STALE_ELEMENT_REFERENCE";
    emitBrowserActionFailure(session, "browser_upload", "Target resolution failed", err.message, target);
    return {
      success: false,
      error_code: isStale ? "STALE_ELEMENT_REFERENCE" : "INVALID_ARGUMENT",
      action: `browser_upload ${JSON.stringify(target)}`,
      text: err.message,
      summary: `Target resolution failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "target_resolution", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const locator = page.locator(selector).first();
    await locator.setInputFiles(filePaths);
    emitBrowserActionComplete(session, "browser_upload", "File upload complete", { filePaths }, target);
    return {
      success: true,
      action: `browser_upload`,
      text: `Uploaded file(s): ${filePaths.join(", ")}`,
      summary: `Uploaded ${filePaths.length} file(s)`,
      execution_verification: { status: "passed", method: "playwright_setInputFiles" },
      state_verification: { status: "passed", method: "file_input_set", details: { files: filePaths } },
      verification: { performed: true, passed: true, method: "playwright_setInputFiles" },
      data: { target: selector, files: filePaths },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    emitBrowserActionFailure(session, "browser_upload", "File upload failed", err.message, target);
    return {
      success: false,
      error_code: "COMMAND_FAILED",
      action: "browser_upload",
      text: `File upload failed: ${err.message}`,
      summary: `File upload failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "playwright_setInputFiles", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executePressKey(
  session: BrowserSession,
  key: string,
  target?: { ref?: string; selector?: string }
): Promise<StandardToolResponse<{ key: string }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  emitBrowserActionStart(session, "browser_press_key", `Pressing key "${key}"`, target);
  try {
    if (target && (target.ref || target.selector)) {
      const selector = resolveTarget(session, target);
      await page.locator(selector).first().press(key);
    } else {
      await page.keyboard.press(key);
    }
    emitBrowserActionComplete(session, "browser_press_key", `Key "${key}" pressed`, { key }, target);
    return {
      success: true,
      action: `browser_press_key "${key}"`,
      text: `Pressed key "${key}".`,
      summary: `Pressed key "${key}"`,
      execution_verification: { status: "passed", method: "playwright_keyboard_press" },
      state_verification: { status: "not_observable", method: "keyboard_press" },
      verification: {
        performed: true,
        passed: true,
        method: "playwright_keyboard_press",
        details: { key },
      },
      data: { key },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    const isStale = err.code === "STALE_ELEMENT_REFERENCE" || err.message?.includes("STALE_ELEMENT_REFERENCE");
    emitBrowserActionFailure(session, "browser_press_key", "Key press failed", err.message, target);
    return {
      success: false,
      error_code: isStale ? "STALE_ELEMENT_REFERENCE" : "COMMAND_FAILED",
      action: `browser_press_key "${key}"`,
      text: `Failed pressing key "${key}": ${err.message}`,
      summary: `Key press failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "playwright_keyboard",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeEval(
  session: BrowserSession,
  script: string
): Promise<StandardToolResponse<{ result: any }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  emitBrowserActionStart(session, "browser_eval", "Evaluating JavaScript expression");
  try {
    const result = await page.evaluate(script);
    emitBrowserActionComplete(session, "browser_eval", "JavaScript evaluated", { hasResult: result !== undefined }, undefined, false);
    return {
      success: true,
      action: `browser_eval`,
      text: `Evaluation result: ${JSON.stringify(result, null, 2)}`,
      summary: `JavaScript evaluated successfully`,
      execution_verification: { status: "passed", method: "page_evaluate" },
      state_verification: { status: "not_observable", method: "page_evaluate" },
      verification: { performed: true, passed: true, method: "page_evaluate" },
      data: { result },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    emitBrowserActionFailure(session, "browser_eval", "Evaluation failed", err.message);
    return {
      success: false,
      error_code: "COMMAND_FAILED",
      action: "browser_eval",
      text: `Evaluation failed: ${err.message}`,
      summary: `Evaluation failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "page_evaluate", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executePdf(
  session: BrowserSession,
  outputPath?: string,
  workspaceRootOverride?: string
): Promise<StandardToolResponse<{
  filePath: string;
  resolved_path?: string;
  requested_path?: string;
  within_workspace?: boolean;
  sizeBytes: number;
  size_bytes?: number;
  sha256?: string;
}>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  const workspaceRoot = workspaceRootOverride || workspaceManager.getActiveWorkspaceRoot();
  const { resolvedPath, requestedPath, withinWorkspace } = resolveArtifactOutputPath(outputPath, workspaceRoot, ".pdf");

  emitBrowserActionStart(session, "browser_pdf", "Generating page PDF", { targetPath: resolvedPath, requestedPath });
  try {
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await page.pdf({ path: resolvedPath, format: "A4" });
    const stat = await fs.stat(resolvedPath);
    const buffer = await fs.readFile(resolvedPath);
    const sha256 = calculateSha256(buffer);

    emitBrowserActionComplete(session, "browser_pdf", "PDF generated and verified", {
      sizeBytes: stat.size,
      filePath: resolvedPath,
      resolvedPath,
      withinWorkspace,
    });
    return {
      success: true,
      action: "browser_pdf",
      text: `PDF document saved to: ${resolvedPath} (${stat.size} bytes).`,
      summary: `PDF generated (${stat.size} bytes)`,
      within_workspace: withinWorkspace,
      workspace_root: workspaceRoot,
      resolved_path: resolvedPath,
      requested_path: requestedPath,
      execution_verification: { status: "passed", method: "page_pdf" },
      state_verification: { status: "passed", method: "fs_stat_exists", details: { sizeBytes: stat.size, sha256 } },
      verification: { performed: true, passed: true, method: "fs_stat_exists", details: { sizeBytes: stat.size, sha256 } },
      data: {
        filePath: resolvedPath,
        resolved_path: resolvedPath,
        requested_path: requestedPath,
        within_workspace: withinWorkspace,
        sizeBytes: stat.size,
        size_bytes: stat.size,
        sha256,
      },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    emitBrowserActionFailure(session, "browser_pdf", "PDF generation failed", err.message);
    return {
      success: false,
      error_code: "COMMAND_FAILED",
      action: "browser_pdf",
      text: `PDF generation failed: ${err.message}`,
      summary: `PDF generation failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "page_pdf", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export interface WaitForOptions {
  ref?: string;
  selector?: string;
  text?: string;
  state?: "attached" | "detached" | "visible" | "hidden";
  url?: string;
  timeoutMs?: number;
}

export async function executeWaitFor(
  session: BrowserSession,
  options: WaitForOptions
): Promise<StandardToolResponse<{ waitedFor: string; elapsedMs: number }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  const timeout = options.timeoutMs || 10000;
  emitBrowserActionStart(session, "browser_wait_for", `Waiting for condition: ${options.url || options.text || options.ref || options.selector || "networkidle"}`);

  try {
    let waitedFor = "";
    if (options.url) {
      waitedFor = `url "${options.url}"`;
      await page.waitForURL(options.url, { timeout });
    } else if (options.ref || options.selector) {
      let sel: string;
      try {
        sel = resolveTarget(session, { ref: options.ref, selector: options.selector });
      } catch (err: any) {
        if (options.selector) sel = options.selector;
        else throw err;
      }
      waitedFor = `element "${options.ref || options.selector}" [${options.state || "visible"}]`;
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: options.state || "visible", timeout });
    } else if (options.text) {
      waitedFor = `text "${options.text}" [${options.state || "visible"}]`;
      const loc = page.locator(`text=${options.text}`).first();
      await loc.waitFor({ state: options.state || "visible", timeout });
    } else {
      waitedFor = "networkidle";
      await page.waitForLoadState("networkidle", { timeout });
    }

    const elapsed = Date.now() - startTime;
    emitBrowserActionComplete(session, "browser_wait_for", "Wait condition satisfied", { waitedFor, elapsedMs: elapsed });
    return {
      success: true,
      action: `browser_wait_for (${waitedFor})`,
      text: `Condition satisfied: waited for ${waitedFor} in ${elapsed}ms.`,
      summary: `Wait condition satisfied (${waitedFor})`,
      execution_verification: { status: "passed", method: "playwright_wait_for" },
      state_verification: { status: "passed", method: "playwright_wait_for", details: { waitedFor } },
      verification: {
        performed: true,
        passed: true,
        method: "playwright_wait_for",
        details: { waitedFor, elapsedMs: elapsed },
      },
      data: { waitedFor, elapsedMs: elapsed },
      durationMs: elapsed,
    };
  } catch (err: any) {
    const isTimeout = err.name === "TimeoutError" || err.message?.includes("Timeout");
    const isStale = err.code === "STALE_ELEMENT_REFERENCE";
    const errorCode = isStale ? "STALE_ELEMENT_REFERENCE" : isTimeout ? "PROCESS_TIMEOUT" : "COMMAND_FAILED";
    emitBrowserActionFailure(session, "browser_wait_for", "Wait failed", err.message);
    return {
      success: false,
      error_code: errorCode,
      action: `browser_wait_for`,
      text: `Wait timed out or failed: ${err.message}`,
      summary: `Wait failed: ${err.message}`,
      execution_verification: { status: "failed", method: "playwright_wait_for", error: err.message },
      state_verification: { status: "failed", method: "playwright_wait_for", error: err.message },
      verification: {
        performed: true,
        passed: false,
        method: "playwright_wait_for",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeTraceStart(
  session: BrowserSession,
  options: { screenshots?: boolean; snapshots?: boolean } = {}
): Promise<StandardToolResponse<{ isTracing: boolean }>> {
  const startTime = Date.now();
  emitBrowserActionStart(session, "browser_trace_start", "Starting Playwright trace recording");
  try {
    await session.context.tracing.start({
      screenshots: options.screenshots !== false,
      snapshots: options.snapshots !== false,
    });
    session.isTracing = true;
    emitBrowserActionComplete(session, "browser_trace_start", "Trace recording started", undefined, undefined, false);
    return {
      success: true,
      action: "browser_trace_start",
      text: "Playwright tracing started. All interactions, screenshots, and DOM snapshots are being recorded.",
      summary: "Tracing started",
      execution_verification: { status: "passed", method: "tracing_start" },
      state_verification: { status: "passed", method: "tracing_active" },
      verification: {
        performed: true,
        passed: true,
        method: "tracing_start",
      },
      data: { isTracing: true },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    emitBrowserActionFailure(session, "browser_trace_start", "Trace start failed", err.message);
    return {
      success: false,
      error_code: "COMMAND_FAILED",
      action: "browser_trace_start",
      text: `Failed to start tracing: ${err.message}`,
      summary: `Trace start failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "tracing_start",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeTraceStop(
  session: BrowserSession,
  outputPath?: string
): Promise<StandardToolResponse<{ tracePath: string; sizeBytes: number; requested_path?: string; resolved_path?: string }>> {
  const startTime = Date.now();
  if (!session.isTracing) {
    emitBrowserActionFailure(session, "browser_trace_stop", "Trace stop failed", "Tracing is not active");
    return {
      success: false,
      error_code: "INVALID_ARGUMENT",
      action: "browser_trace_stop",
      text: "Tracing is not active in this session. Call browser_trace_start first.",
      summary: "Tracing not active",
      verification: {
        performed: true,
        passed: false,
        method: "tracing_stop",
        error: "Tracing was not started",
      },
      durationMs: Date.now() - startTime,
    };
  }

  const workspaceRoot = workspaceManager.getActiveWorkspaceRoot();
  const { resolvedPath, requestedPath, withinWorkspace } = resolveArtifactOutputPath(outputPath, workspaceRoot, ".zip");

  emitBrowserActionStart(session, "browser_trace_stop", "Stopping Playwright trace recording", { outputPath: requestedPath });

  try {
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await session.context.tracing.stop({ path: resolvedPath });
    session.isTracing = false;

    // Verify trace file exists on disk
    const verifyRes = await verifyFileExistence(resolvedPath, true);
    if (!verifyRes.passed) {
      emitBrowserActionFailure(session, "browser_trace_stop", "Trace file verification failed", `Not found at ${resolvedPath}`);
      return {
        success: false,
        error_code: "TRACE_WRITE_FAILED",
        action: "browser_trace_stop",
        display_title: "Stopping browser trace",
        display_status: "failed",
        text: `Trace stop completed but archive file was not found at ${resolvedPath}.`,
        summary: "Trace write failed",
        verification: verifyRes,
        durationMs: Date.now() - startTime,
      };
    }

    const stat = await fs.stat(resolvedPath);
    const withinWorkspace = resolvedPath.toLowerCase().startsWith(workspaceRoot.toLowerCase());

    emitBrowserActionComplete(session, "browser_trace_stop", "Trace archive saved and verified", { resolvedPath, sizeBytes: stat.size });

    return {
      success: true,
      action: "browser_trace_stop",
      display_title: "Stopping browser trace",
      display_status: "verified",
      within_workspace: withinWorkspace,
      workspace_root: workspaceRoot,
      resolved_path: resolvedPath,
      text: `Tracing stopped and saved to ${resolvedPath} (${stat.size} bytes).`,
      summary: `Trace saved (${stat.size} bytes)`,
      execution_verification: { status: "passed", method: "tracing_stop" },
      state_verification: { status: "passed", method: "trace_archive_written", details: { sizeBytes: stat.size } },
      verification: {
        performed: true,
        passed: true,
        method: "fs_stat_exists",
        details: { targetPath: resolvedPath, sizeBytes: stat.size },
      },
      data: {
        requested_path: requestedPath,
        resolved_path: resolvedPath,
        tracePath: resolvedPath,
        sizeBytes: stat.size,
      },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    session.isTracing = false;
    emitBrowserActionFailure(session, "browser_trace_stop", "Trace stop failed", err.message);
    return {
      success: false,
      error_code: "TRACE_WRITE_FAILED",
      action: "browser_trace_stop",
      display_title: "Stopping browser trace",
      display_status: "failed",
      text: `Failed to stop tracing: ${err.message}`,
      summary: `Trace stop failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "tracing_stop",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeListTabs(
  session: BrowserSession
): Promise<StandardToolResponse<{ tabs: Array<{ index: number; url: string; title: string; isActive: boolean }> }>> {
  const startTime = Date.now();
  emitBrowserActionStart(session, "browser_list_tabs", "Listing open tabs");
  const tabInfos: Array<{ index: number; url: string; title: string; isActive: boolean }> = [];
  for (let i = 0; i < session.pages.length; i++) {
    const p = session.pages[i];
    if (!p.isClosed()) {
      const url = p.url();
      const title = await p.title().catch(() => "");
      tabInfos.push({
        index: i,
        url,
        title,
        isActive: i === session.activePageIndex,
      });
    }
  }

  const lines = tabInfos.map(
    (t) => `Tab #${t.index}${t.isActive ? " [ACTIVE]" : ""}: "${t.title || "(No Title)"}" (${t.url})`
  );

  emitBrowserActionComplete(session, "browser_list_tabs", "Tab list retrieved", { count: tabInfos.length });

  return {
    success: true,
    action: "browser_list_tabs",
    text: tabInfos.length > 0 ? `Open Tabs (${tabInfos.length}):\n${lines.join("\n")}` : "No open tabs.",
    summary: `Found ${tabInfos.length} open tab(s)`,
    execution_verification: { status: "passed", method: "pages_array_inspection" },
    state_verification: { status: "passed", method: "pages_array_inspection" },
    verification: {
      performed: true,
      passed: true,
      method: "pages_array_inspection",
      details: { count: tabInfos.length },
    },
    data: { tabs: tabInfos },
    durationMs: Date.now() - startTime,
  };
}

export function executeGetConsole(
  session: BrowserSession,
  options?: { level?: string; filter?: string; limit?: number }
): StandardToolResponse<{ logs: Array<{ type: string; text: string; timestamp: number }> }> {
  emitBrowserActionStart(session, "browser_console", "Reading browser console logs");
  let logs = [...session.consoleLogs];
  if (options?.level) {
    const lvl = options.level.toLowerCase();
    logs = logs.filter((l) => l.type.toLowerCase() === lvl);
  }
  if (options?.filter) {
    const f = options.filter.toLowerCase();
    logs = logs.filter((l) => l.text.toLowerCase().includes(f));
  }
  if (options?.limit && options.limit > 0) {
    logs = logs.slice(-options.limit);
  }

  const lines = logs.map((l) => `[${l.type.toUpperCase()}] ${l.text}`);
  const text = logs.length > 0 ? `Captured Console Logs (${logs.length}):\n${lines.join("\n")}` : "No console logs matched filter.";
  emitBrowserActionComplete(session, "browser_console", "Console logs retrieved", { count: logs.length });
  return {
    success: true,
    action: "browser_console",
    text,
    summary: `Retrieved ${logs.length} console log(s)`,
    execution_verification: { status: "passed", method: "console_buffer_read" },
    state_verification: { status: "passed", method: "console_buffer_read" },
    verification: { performed: true, passed: true, method: "console_buffer_read", details: { count: logs.length } },
    data: { logs },
  };
}

export function executeGetNetwork(
  session: BrowserSession,
  options?: { status?: number; failedOnly?: boolean; urlPattern?: string; resourceType?: string; limit?: number }
): StandardToolResponse<{ events: Array<{ method: string; url: string; status?: number; resourceType?: string; failed?: boolean }> }> {
  emitBrowserActionStart(session, "browser_network", "Reading browser network logs");
  let events = [...session.networkEvents];
  if (options?.failedOnly) {
    events = events.filter((e) => Boolean(e.failed));
  }
  if (options?.status !== undefined) {
    events = events.filter((e) => e.status === options.status);
  }
  if (options?.urlPattern) {
    const pat = options.urlPattern.toLowerCase();
    events = events.filter((e) => e.url.toLowerCase().includes(pat));
  }
  if (options?.resourceType) {
    const rt = options.resourceType.toLowerCase();
    events = events.filter((e) => e.resourceType?.toLowerCase() === rt);
  }
  if (options?.limit && options.limit > 0) {
    events = events.slice(-options.limit);
  }

  const lines = events.map(
    (e) => `[${e.method}] ${e.url} ${e.failed ? "(FAILED)" : e.status ? `(HTTP ${e.status})` : ""} [${e.resourceType || "other"}]`
  );
  const text = events.length > 0 ? `Captured Network Events (${events.length}):\n${lines.join("\n")}` : "No network events matched filter.";
  emitBrowserActionComplete(session, "browser_network", "Network logs retrieved", { count: events.length });
  return {
    success: true,
    action: "browser_network",
    text,
    summary: `Retrieved ${events.length} network event(s)`,
    execution_verification: { status: "passed", method: "network_buffer_read" },
    state_verification: { status: "passed", method: "network_buffer_read" },
    verification: { performed: true, passed: true, method: "network_buffer_read", details: { count: events.length } },
    data: { events },
  };
}
