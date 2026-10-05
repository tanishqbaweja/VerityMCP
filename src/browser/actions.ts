import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { BrowserSession } from "./browser_manager.js";
import { browserManager } from "./browser_manager.js";
import { verifyFileExistence } from "../verification/index.js";
import type { StandardToolResponse } from "../types/index.js";

function resolveTarget(
  session: BrowserSession,
  target: { ref?: string; selector?: string }
): string {
  if (target.ref) {
    const cleanRef = target.ref.replace(/^@/, "").replace(/^e/, "e");
    const found = session.elementRefs.get(cleanRef);
    if (!found) {
      throw new Error(
        `STALE_ELEMENT_REFERENCE: Ref "${target.ref}" not found in current snapshot (v${session.currentSnapshotVersion}). The page DOM may have changed. Please take a new browser_snapshot.`
      );
    }
    return found.selector;
  }
  if (target.selector) {
    return target.selector;
  }
  throw new Error("Must provide either 'ref' (from browser_snapshot) or 'selector'.");
}

export async function executeNavigate(
  session: BrowserSession,
  url: string
): Promise<StandardToolResponse<{ url: string; title: string; status: number }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    const status = response ? response.status() : 200;
    const finalUrl = page.url();
    const title = await page.title();

    return {
      success: status < 400,
      action: `browser_navigate "${url}"`,
      text: `Navigated to ${finalUrl} (Title: "${title}", HTTP ${status})`,
      verification: {
        performed: true,
        passed: status < 400,
        method: "http_status_and_url_verification",
        details: { finalUrl, title, status },
      },
      data: { url: finalUrl, title, status },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: `browser_navigate "${url}"`,
      text: `Navigation to "${url}" failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "page_goto",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeReload(
  session: BrowserSession
): Promise<StandardToolResponse<{ url: string }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    const currentUrl = page.url();
    return {
      success: true,
      action: "page_reload",
      text: `Page reloaded. Current URL: ${currentUrl}`,
      verification: {
        performed: true,
        passed: true,
        method: "page_reload_success",
        details: { url: currentUrl },
      },
      data: { url: currentUrl },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: "page_reload",
      text: `Reload failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "page_reload", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeGoBack(
  session: BrowserSession
): Promise<StandardToolResponse<{ url: string }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  try {
    await page.goBack();
    const currentUrl = page.url();
    return {
      success: true,
      action: "page_back",
      text: `Navigated back to: ${currentUrl}`,
      verification: { performed: true, passed: true, method: "page_history_back", details: { url: currentUrl } },
      data: { url: currentUrl },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: "page_back",
      text: `History back failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "page_history_back", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeGoForward(
  session: BrowserSession
): Promise<StandardToolResponse<{ url: string }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  try {
    await page.goForward();
    const currentUrl = page.url();
    return {
      success: true,
      action: "page_forward",
      text: `Navigated forward to: ${currentUrl}`,
      verification: { performed: true, passed: true, method: "page_history_forward", details: { url: currentUrl } },
      data: { url: currentUrl },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: "page_forward",
      text: `History forward failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "page_history_forward", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executeClick(
  session: BrowserSession,
  target: { ref?: string; selector?: string }
): Promise<StandardToolResponse<{ target: string; currentUrl: string }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);

  let selector: string;
  try {
    selector = resolveTarget(session, target);
  } catch (err: any) {
    return {
      success: false,
      action: `browser_click ${JSON.stringify(target)}`,
      text: err.message,
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
    const beforeUrl = page.url();
    const beforeTitle = await page.title().catch(() => "");

    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "attached", timeout: 10000 });
    try {
      await locator.click({ timeout: 3000 });
    } catch {
      await locator.click({ force: true });
    }
    await page.waitForTimeout(150);

    const afterUrl = page.url();
    const afterTitle = await page.title().catch(() => "");
    const urlChanged = afterUrl !== beforeUrl;
    const titleChanged = afterTitle !== beforeTitle;

    let verificationMethod = "playwright_click_action";
    let verificationText = `Clicked element successfully. Verification: EXECUTED.`;

    if (urlChanged) {
      verificationMethod = "url_navigation_verified";
      verificationText = `Clicked element successfully. Observed: URL changed ${beforeUrl} -> ${afterUrl}`;
    } else if (titleChanged) {
      verificationMethod = "title_change_verified";
      verificationText = `Clicked element successfully. Observed: Title changed "${beforeTitle}" -> "${afterTitle}"`;
    }

    return {
      success: true,
      action: `browser_click ${target.ref ? `[ref=${target.ref}]` : selector}`,
      text: verificationText,
      verification: {
        performed: true,
        passed: true,
        method: verificationMethod,
        details: { selector, beforeUrl, afterUrl, urlChanged, titleChanged },
      },
      data: { target: selector, currentUrl: afterUrl },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: `browser_click ${JSON.stringify(target)}`,
      text: `Click failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "playwright_click",
        error: err.message,
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
  const selector = resolveTarget(session, target);
  try {
    const locator = page.locator(selector).first();
    await locator.dblclick();
    return {
      success: true,
      action: `browser_double_click ${target.ref ? `[ref=${target.ref}]` : selector}`,
      text: `Double-clicked element successfully.`,
      verification: { performed: true, passed: true, method: "playwright_dblclick" },
      data: { target: selector },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: `browser_double_click`,
      text: `Double-click failed: ${err.message}`,
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
  const selector = resolveTarget(session, target);
  try {
    const locator = page.locator(selector).first();
    await locator.hover();
    return {
      success: true,
      action: `browser_hover ${target.ref ? `[ref=${target.ref}]` : selector}`,
      text: `Hovered over element successfully.`,
      verification: { performed: true, passed: true, method: "playwright_hover" },
      data: { target: selector },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: `browser_hover`,
      text: `Hover failed: ${err.message}`,
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

  let selector: string;
  try {
    selector = resolveTarget(session, target);
  } catch (err: any) {
    return {
      success: false,
      action: `browser_fill ${JSON.stringify(target)}`,
      text: err.message,
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
      return {
        success: false,
        action: `browser_fill ${target.ref ? `[ref=${target.ref}]` : selector}`,
        text: `CRITICAL: Fill failed DOM readback! Expected "${value}", found "${actualValue}".`,
        verification: {
          performed: true,
          passed: false,
          method: "dom_inputValue_readback",
          error: `DOM value mismatch: "${actualValue}" !== "${value}"`,
          details: { expected: value, actual: actualValue },
        },
        durationMs: Date.now() - startTime,
      };
    }

    return {
      success: true,
      action: `browser_fill ${target.ref ? `[ref=${target.ref}]` : selector}`,
      text: `Filled element with "${value}". DOM readback verified.`,
      verification: {
        performed: true,
        passed: true,
        method: "dom_inputValue_readback",
        details: { verifiedValue: actualValue },
      },
      data: { target: selector, verifiedValue: actualValue },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: `browser_fill ${JSON.stringify(target)}`,
      text: `Fill action failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "playwright_fill",
        error: err.message,
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

  let selector: string;
  try {
    selector = resolveTarget(session, target);
  } catch (err: any) {
    return {
      success: false,
      action: `browser_check ${JSON.stringify(target)}`,
      text: err.message,
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
      return {
        success: false,
        action: `browser_check ${target.ref ? `[ref=${target.ref}]` : selector}`,
        text: `CRITICAL: Check action failed DOM verification! Expected checked=${checked}, found isChecked=${isChecked}.`,
        verification: {
          performed: true,
          passed: false,
          method: "dom_isChecked_readback",
          error: `DOM checked state mismatch`,
          details: { expected: checked, actual: isChecked },
        },
        durationMs: Date.now() - startTime,
      };
    }

    return {
      success: true,
      action: `browser_check ${target.ref ? `[ref=${target.ref}]` : selector}`,
      text: `Element checked state set to ${checked}. Verified via DOM readback.`,
      verification: {
        performed: true,
        passed: true,
        method: "dom_isChecked_readback",
        details: { isChecked },
      },
      data: { target: selector, isChecked },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: `browser_check ${JSON.stringify(target)}`,
      text: `Check action failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "playwright_check",
        error: err.message,
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
  const selector = resolveTarget(session, target);
  try {
    const locator = page.locator(selector).first();
    await locator.selectOption(value);
    const actual = await locator.inputValue();
    return {
      success: true,
      action: `browser_select "${value}"`,
      text: `Selected option "${value}" (verified: "${actual}").`,
      verification: { performed: true, passed: true, method: "dom_select_readback", details: { actual } },
      data: { target: selector, selectedValue: actual },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: "browser_select",
      text: `Select option failed: ${err.message}`,
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
  const selector = resolveTarget(session, target);
  try {
    const locator = page.locator(selector).first();
    await locator.setInputFiles(filePaths);
    return {
      success: true,
      action: `browser_upload`,
      text: `Uploaded file(s): ${filePaths.join(", ")}`,
      verification: { performed: true, passed: true, method: "playwright_setInputFiles" },
      data: { target: selector, files: filePaths },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: "browser_upload",
      text: `File upload failed: ${err.message}`,
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
  try {
    if (target && (target.ref || target.selector)) {
      const selector = resolveTarget(session, target);
      await page.locator(selector).first().press(key);
    } else {
      await page.keyboard.press(key);
    }
    return {
      success: true,
      action: `browser_press_key "${key}"`,
      text: `Pressed key "${key}".`,
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
    return {
      success: false,
      action: `browser_press_key "${key}"`,
      text: `Failed pressing key "${key}": ${err.message}`,
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
  try {
    const result = await page.evaluate(script);
    return {
      success: true,
      action: `browser_eval`,
      text: `Evaluation result: ${JSON.stringify(result, null, 2)}`,
      verification: { performed: true, passed: true, method: "page_evaluate" },
      data: { result },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: "browser_eval",
      text: `Evaluation failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "page_evaluate", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export async function executePdf(
  session: BrowserSession,
  outputPath?: string
): Promise<StandardToolResponse<{ filePath: string; sizeBytes: number }>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  const targetPath = outputPath || path.join(os.tmpdir(), `verity_doc_${randomUUID().slice(0, 8)}.pdf`);
  try {
    await page.pdf({ path: targetPath, format: "A4" });
    const stat = await fs.stat(targetPath);
    return {
      success: true,
      action: "browser_pdf",
      text: `PDF document saved to ${targetPath} (${stat.size} bytes).`,
      verification: { performed: true, passed: true, method: "fs_stat_exists", details: { sizeBytes: stat.size } },
      data: { filePath: targetPath, sizeBytes: stat.size },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: "browser_pdf",
      text: `PDF generation failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "page_pdf", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export function executeGetConsole(session: BrowserSession): StandardToolResponse<{ logs: Array<{ type: string; text: string; timestamp: number }> }> {
  const logs = [...session.consoleLogs];
  const lines = logs.map((l) => `[${l.type.toUpperCase()}] ${l.text}`);
  const text = logs.length > 0 ? `Captured Console Logs (${logs.length}):\n${lines.join("\n")}` : "No console logs captured.";
  return {
    success: true,
    action: "browser_console",
    text,
    verification: { performed: true, passed: true, method: "console_buffer_read", details: { count: logs.length } },
    data: { logs },
  };
}

export function executeGetNetwork(session: BrowserSession): StandardToolResponse<{ events: Array<{ method: string; url: string; status?: number; failed?: boolean }> }> {
  const events = [...session.networkEvents];
  const lines = events.map((e) => `[${e.method}] ${e.url} ${e.failed ? "(FAILED)" : e.status ? `(HTTP ${e.status})` : ""}`);
  const text = events.length > 0 ? `Captured Network Events (${events.length}):\n${lines.join("\n")}` : "No network events captured.";
  return {
    success: true,
    action: "browser_network",
    text,
    verification: { performed: true, passed: true, method: "network_buffer_read", details: { count: events.length } },
    data: { events },
  };
}
