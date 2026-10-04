import type { BrowserSession } from "./browser_manager.js";
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
  const page = session.page;

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

export async function executeClick(
  session: BrowserSession,
  target: { ref?: string; selector?: string }
): Promise<StandardToolResponse<{ target: string; currentUrl: string }>> {
  const startTime = Date.now();
  const page = session.page;

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
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout: 10000 });
    await locator.click();

    // Brief settling wait for microtasks/animations
    await page.waitForTimeout(100);

    const currentUrl = page.url();
    return {
      success: true,
      action: `browser_click ${target.ref ? `[ref=${target.ref}]` : selector}`,
      text: `Clicked element successfully. Current URL: ${currentUrl}`,
      verification: {
        performed: true,
        passed: true,
        method: "playwright_click_action",
        details: { selector, currentUrl },
      },
      data: { target: selector, currentUrl },
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

export async function executeFill(
  session: BrowserSession,
  target: { ref?: string; selector?: string },
  value: string
): Promise<StandardToolResponse<{ target: string; verifiedValue: string }>> {
  const startTime = Date.now();
  const page = session.page;

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
  const page = session.page;

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
    await locator.waitFor({ state: "visible", timeout: 10000 });
    await locator.setChecked(checked);

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

export async function executePressKey(
  session: BrowserSession,
  key: string
): Promise<StandardToolResponse<{ key: string }>> {
  const startTime = Date.now();
  try {
    await session.page.keyboard.press(key);
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
