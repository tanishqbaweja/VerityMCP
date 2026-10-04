import type { BrowserSession } from "./browser_manager.js";
import type { StandardToolResponse } from "../types/index.js";

export interface ElementSnapshotInfo {
  ref: string;
  tagName: string;
  role?: string;
  type?: string;
  name?: string;
  text?: string;
  placeholder?: string;
  value?: string;
  isChecked?: boolean;
  isDisabled?: boolean;
  selector: string;
}

export interface BrowserSnapshotData {
  url: string;
  title: string;
  version: number;
  interactiveElementsCount: number;
  snapshotText: string;
  elements: ElementSnapshotInfo[];
}

export async function takeBrowserSnapshot(
  session: BrowserSession
): Promise<StandardToolResponse<BrowserSnapshotData>> {
  const startTime = Date.now();
  const page = session.page;

  let url = "about:blank";
  let title = "";
  try {
    url = page.url();
    title = await page.title();
  } catch (err: any) {
    return {
      success: false,
      action: "browser_snapshot",
      text: `Failed to inspect browser page: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "page_inspection",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  session.currentSnapshotVersion += 1;
  const currentVersion = session.currentSnapshotVersion;
  session.elementRefs.clear();

  // Extract interactive elements from DOM
  const rawElements = await page.evaluate(() => {
    const results: Array<{
      tagName: string;
      role: string;
      type: string;
      name: string;
      text: string;
      placeholder: string;
      value: string;
      isChecked: boolean;
      isDisabled: boolean;
      selector: string;
    }> = [];

    const query =
      'a[href], button, input, textarea, select, [role="button"], [role="checkbox"], [role="radio"], [role="link"], [role="tab"], [tabindex]:not([tabindex="-1"])';
    const nodes = Array.from(document.querySelectorAll(query));

    let index = 0;
    for (const el of nodes) {
      const htmlEl = el as HTMLElement;
      // Skip invisible elements
      const style = window.getComputedStyle(htmlEl);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0" ||
        htmlEl.offsetWidth === 0 ||
        htmlEl.offsetHeight === 0
      ) {
        continue;
      }

      index++;
      // Assign custom attribute for stable lookup
      htmlEl.setAttribute("data-devspace-ref", `e${index}`);

      const inputEl = el as HTMLInputElement;
      results.push({
        tagName: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        type: inputEl.type || "",
        name: el.getAttribute("name") || el.getAttribute("aria-label") || "",
        text: (el.textContent || "").trim().slice(0, 100),
        placeholder: inputEl.placeholder || "",
        value: inputEl.value !== undefined ? String(inputEl.value) : "",
        isChecked: Boolean(inputEl.checked),
        isDisabled: Boolean(htmlEl.hasAttribute("disabled") || htmlEl.getAttribute("aria-disabled") === "true"),
        selector: `[data-devspace-ref="e${index}"]`,
      });
    }

    return results;
  });

  const snapshotElements: ElementSnapshotInfo[] = [];
  const lines: string[] = [
    `Page: ${title || "(No Title)"}`,
    `URL: ${url}`,
    `Snapshot Version: ${currentVersion}`,
    `Interactive Elements:`,
  ];

  rawElements.forEach((el, idx) => {
    const ref = `e${idx + 1}`;
    session.elementRefs.set(ref, {
      selector: el.selector,
      role: el.role || el.tagName,
      name: el.name || el.text,
      text: el.text,
      isChecked: el.isChecked,
    });

    const info: ElementSnapshotInfo = {
      ref,
      ...el,
    };
    snapshotElements.push(info);

    const descParts = [`[ref=${ref}]`, `<${el.tagName}>`];
    if (el.type) descParts.push(`type="${el.type}"`);
    if (el.name) descParts.push(`name="${el.name}"`);
    if (el.placeholder) descParts.push(`placeholder="${el.placeholder}"`);
    if (el.text && el.tagName !== "input") descParts.push(`"${el.text}"`);
    if (el.value && el.tagName === "input" && el.type !== "password") descParts.push(`value="${el.value}"`);
    if (el.type === "checkbox" || el.role === "checkbox") {
      descParts.push(`[checked=${el.isChecked}]`);
    }
    if (el.isDisabled) descParts.push(`[disabled]`);

    lines.push(`  - ${descParts.join(" ")}`);
  });

  if (rawElements.length === 0) {
    lines.push("  (No interactive elements detected)");
  }

  const snapshotText = lines.join("\n");

  return {
    success: true,
    action: `browser_snapshot (v${currentVersion})`,
    text: snapshotText,
    verification: {
      performed: true,
      passed: true,
      method: "dom_accessibility_tree_extraction",
      details: {
        version: currentVersion,
        interactiveElementsCount: rawElements.length,
        url,
      },
    },
    data: {
      url,
      title,
      version: currentVersion,
      interactiveElementsCount: rawElements.length,
      snapshotText,
      elements: snapshotElements,
    },
    durationMs: Date.now() - startTime,
  };
}
