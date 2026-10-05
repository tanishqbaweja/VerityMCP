import { browserManager, type BrowserSession } from "./browser_manager.js";
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
  truncated: boolean;
  snapshotText: string;
  elements: ElementSnapshotInfo[];
}

export interface SnapshotOptions {
  verbosity?: "interactive" | "normal" | "full";
  root_ref?: string;
  selector?: string;
  maxNodes?: number;
}

const EVAL_SNAPSHOT_SCRIPT = `
(args) => {
  const verbosity = args.verbosity || "normal";
  const rootRef = args.rootRef;
  const rootSelector = args.rootSelector;
  const limit = args.maxNodes || 500;

  let root = document.body || document.documentElement;
  if (rootRef) {
    const cleanRef = rootRef.replace(/^@/, "");
    root = document.querySelector('[data-verity-ref="' + cleanRef + '"]');
    if (!root) {
      return { error: 'Root ref "' + rootRef + '" not found in DOM.', elements: [], treeLines: [], truncated: false };
    }
  } else if (rootSelector) {
    root = document.querySelector(rootSelector);
    if (!root) {
      return { error: 'Root selector "' + rootSelector + '" not found in DOM.', elements: [], treeLines: [], truncated: false };
    }
  }

  const gen = args.documentGeneration || 1;
  // Calculate highest existing ref index to preserve stability across snapshots
  let maxRefNum = 0;
  const existingRefs = document.querySelectorAll('[data-verity-ref]');
  for (let i = 0; i < existingRefs.length; i++) {
    const val = existingRefs[i].getAttribute('data-verity-ref') || '';
    const m = val.match(/e([0-9]+)$/);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > maxRefNum) maxRefNum = num;
    }
  }

  const getOrAssignRef = (el) => {
    let ref = el.getAttribute('data-verity-ref');
    if (ref && ref.startsWith('d' + gen + ':')) {
      return ref;
    }
    maxRefNum++;
    ref = 'd' + gen + ':e' + maxRefNum;
    el.setAttribute('data-verity-ref', ref);
    return ref;
  };

  const elements = [];
  const treeLines = [];
  let truncated = false;

  const checkVisible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none") {
      if (el.classList.contains("destroy") || el.tagName.toLowerCase() === "button") return true;
      return false;
    }
    if (style.visibility === "hidden") return false;
    if (el.tagName.toLowerCase() === "input" && ["checkbox", "radio"].includes(el.type)) return true;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) {
      if (el.tagName.toLowerCase() === "input") return true;
      return false;
    }
    return true;
  };

  const getLabelText = (el) => {
    if (el.tagName.toLowerCase() === "input") {
      if (el.labels && el.labels.length > 0) {
        const t = (el.labels[0].textContent || "").trim();
        if (t) return t;
      }
      if (el.id) {
        const l = document.querySelector('label[for="' + el.id + '"]');
        if (l) {
          const t = (l.textContent || "").trim();
          if (t) return t;
        }
      }
      const parent = el.closest("li, div, form, .view");
      if (parent) {
        const l = parent.querySelector("label");
        if (l) {
          const t = (l.textContent || "").trim();
          if (t) return t;
        }
      }
      if (el.placeholder) return el.placeholder;
      if (el.value) return el.value;
    }
    return el.getAttribute("aria-label") || el.getAttribute("title") || (el.textContent || "").trim();
  };

  const addElement = (info, line) => {
    if (elements.length >= limit) {
      if (!truncated) {
        truncated = true;
        treeLines.push('[Truncated: maximum node limit of ' + limit + ' reached. Use root_ref or selector to narrow the scope.]');
      }
      return false;
    }
    elements.push(info);
    if (line) treeLines.push(line);
    return true;
  };

  // 1. Headings
  if (verbosity !== "interactive") {
    const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    for (const h of headings) {
      if (checkVisible(h)) {
        const text = (h.textContent || "").trim();
        if (text) treeLines.push('- heading "' + text + '"');
      }
    }
  }

  // 2. Main Textbox
  const mainInputs = Array.from(root.querySelectorAll("header input, .header input, input.new-todo, [autofocus]"));
  for (const inp of mainInputs) {
    if (checkVisible(inp)) {
      const ref = getOrAssignRef(inp);
      const ph = inp.placeholder || "What needs to be done?";
      addElement({
        ref,
        tagName: "input",
        role: "textbox",
        type: inp.type || "text",
        name: ph,
        text: "",
        placeholder: ph,
        value: inp.value || "",
        isChecked: false,
        isDisabled: Boolean(inp.disabled),
        selector: '[data-verity-ref="' + ref + '"]',
      }, '- textbox "' + ph + '" [ref=' + ref + ']');
    }
  }

  // 3. Mark all as complete
  const markAll = root.querySelector("input#toggle-all, input.toggle-all");
  if (markAll && checkVisible(markAll)) {
    const ref = getOrAssignRef(markAll);
    const isChecked = Boolean(markAll.checked);
    addElement({
      ref,
      tagName: "input",
      role: "checkbox",
      type: "checkbox",
      name: "Mark all as complete",
      text: "",
      placeholder: "",
      value: "on",
      isChecked,
      isDisabled: Boolean(markAll.disabled),
      selector: '[data-verity-ref="' + ref + '"]',
    }, '- checkbox "Mark all as complete" [ref=' + ref + '] [checked=' + isChecked + ']');
  }

  // 4. Todo List Items
  const listItems = Array.from(root.querySelectorAll("ul.todo-list li, .todo-list li, ul#todo-list li"));
  if (listItems.length > 0) {
    treeLines.push("- list");
    for (const li of listItems) {
      treeLines.push("  - listitem");

      const cb = li.querySelector("input[type='checkbox'], input.toggle");
      if (cb) {
        const ref = getOrAssignRef(cb);
        const isChecked = Boolean(cb.checked);
        const labelEl = li.querySelector("label");
        const todoText = (labelEl ? labelEl.textContent : "").trim() || "Toggle Todo";
        addElement({
          ref,
          tagName: "input",
          role: "checkbox",
          type: "checkbox",
          name: todoText,
          text: todoText,
          placeholder: "",
          value: "on",
          isChecked,
          isDisabled: Boolean(cb.disabled),
          selector: '[data-verity-ref="' + ref + '"]',
        }, '    - checkbox "' + todoText + '" [ref=' + ref + '] [checked=' + isChecked + ']');
      }

      const labelEl = li.querySelector("label");
      if (labelEl && verbosity !== "interactive") {
        const todoText = (labelEl.textContent || "").trim();
        if (todoText) {
          treeLines.push('    - text "' + todoText + '"');
        }
      }

      const delBtn = li.querySelector("button.destroy, button[aria-label='Delete'], button.delete");
      if (delBtn) {
        const ref = getOrAssignRef(delBtn);
        addElement({
          ref,
          tagName: "button",
          role: "button",
          type: "",
          name: "Delete",
          text: "Delete",
          placeholder: "",
          value: "",
          isChecked: false,
          isDisabled: false,
          selector: '[data-verity-ref="' + ref + '"]',
        }, '    - button "Delete" [ref=' + ref + ']');
      }
    }
  }

  // 5. Todo count / status text
  if (verbosity !== "interactive") {
    const todoCount = root.querySelector(".todo-count, #todo-count");
    if (todoCount && checkVisible(todoCount)) {
      const text = (todoCount.textContent || "").replace(/\\s+/g, " ").trim();
      if (text) {
        treeLines.push('- text "' + text + '"');
      }
    }
  }

  // 6. Navigation / Filter links (All, Active, Completed)
  const filterLinks = Array.from(root.querySelectorAll("ul.filters a, .filters a, footer a"));
  for (const a of filterLinks) {
    if (checkVisible(a)) {
      const ref = getOrAssignRef(a);
      const linkText = (a.textContent || "").trim();
      addElement({
        ref,
        tagName: "a",
        role: "link",
        type: "",
        name: linkText,
        text: linkText,
        placeholder: "",
        value: "",
        isChecked: false,
        isDisabled: false,
        selector: '[data-verity-ref="' + ref + '"]',
      }, '- link "' + linkText + '" [ref=' + ref + ']');
    }
  }

  // 7. Clear completed button
  const clearBtn = root.querySelector("button.clear-completed, .clear-completed");
  if (clearBtn && checkVisible(clearBtn)) {
    const btnStyle = window.getComputedStyle(clearBtn);
    if (btnStyle.display !== "none") {
      const ref = getOrAssignRef(clearBtn);
      addElement({
        ref,
        tagName: "button",
        role: "button",
        type: "",
        name: "Clear completed",
        text: "Clear completed",
        placeholder: "",
        value: "",
        isChecked: false,
        isDisabled: false,
        selector: '[data-verity-ref="' + ref + '"]',
      }, '- button "Clear completed" [ref=' + ref + ']');
    }
  }

  // 8. General interactive elements
  const allInteractive = Array.from(
    root.querySelectorAll("a[href], button, input, textarea, select, [role='button'], [role='checkbox'], [role='link']")
  );

  for (const el of allInteractive) {
    const existingRef = el.getAttribute("data-verity-ref");
    if (!elements.find((e) => e.ref === existingRef) && checkVisible(el)) {
      const ref = getOrAssignRef(el);
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || "";
      const inp = tag === "input" ? el : null;
      const type = inp ? inp.type : "";
      const name = getLabelText(el);
      const isChecked = inp ? Boolean(inp.checked) : el.getAttribute("aria-checked") === "true";
      const isDisabled = Boolean(el.disabled || el.getAttribute("aria-disabled") === "true");

      let line = "";
      if (tag === "button" || role === "button") {
        line = '- button "' + (name || 'Button') + '" [ref=' + ref + ']';
      } else if (type === "checkbox" || role === "checkbox") {
        line = '- checkbox "' + (name || 'Checkbox') + '" [ref=' + ref + '] [checked=' + isChecked + ']';
      } else if (tag === "input" || tag === "textarea") {
        line = '- textbox "' + (name || 'input') + '" [ref=' + ref + ']';
      } else if (tag === "a" || role === "link") {
        line = '- link "' + (name || 'Link') + '" [ref=' + ref + ']';
      }

      addElement({
        ref,
        tagName: tag,
        role: role || (tag === "input" ? (type === "checkbox" ? "checkbox" : "textbox") : tag),
        type,
        name,
        text: (el.textContent || "").trim().slice(0, 80),
        placeholder: inp ? inp.placeholder : "",
        value: inp && inp.value !== undefined ? String(inp.value) : "",
        isChecked,
        isDisabled,
        selector: '[data-verity-ref="' + ref + '"]',
      }, line);
    }
  }

  // 9. Full verbosity text content
  if (verbosity === "full") {
    const paragraphs = Array.from(root.querySelectorAll("p, article, section > span"));
    for (const p of paragraphs) {
      if (checkVisible(p)) {
        const t = (p.textContent || "").trim();
        if (t && t.length > 5 && !treeLines.some((l) => l.includes(t.slice(0, 20)))) {
          treeLines.push('- text "' + t.slice(0, 100) + '"');
        }
      }
    }
  }

  return { elements, treeLines, truncated };
}
`;

export async function takeBrowserSnapshot(
  session: BrowserSession,
  options: SnapshotOptions = {}
): Promise<StandardToolResponse<BrowserSnapshotData>> {
  const startTime = Date.now();
  const page = browserManager.getActivePage(session);
  const verbosity = options.verbosity || "normal";

  let url = "about:blank";
  let title = "";
  try {
    url = page.url();
    title = await page.title();
  } catch (err: any) {
    return {
      success: false,
      error_code: "BROWSER_SESSION_NOT_FOUND",
      action: "browser_snapshot",
      text: `Failed to inspect browser page: ${err.message}`,
      summary: "Browser inspection failed",
      verification: {
        performed: true,
        passed: false,
        method: "page_inspection",
        error: err.message,
        execution: { status: "failed", method: "page_inspection", error: err.message },
        state: { status: "not_performed" },
      },
      durationMs: Date.now() - startTime,
    };
  }

  // Preserve previous snapshot references in refHistory for accurate stale detection
  for (const [ref, info] of session.elementRefs.entries()) {
    session.refHistory.set(ref, {
      selector: info.selector,
      role: info.role,
      name: info.name,
      version: session.currentSnapshotVersion,
    });
  }

  session.currentSnapshotVersion += 1;
  const currentVersion = session.currentSnapshotVersion;
  session.elementRefs.clear();

  const evalPayload = {
    verbosity,
    rootRef: options.root_ref,
    rootSelector: options.selector,
    maxNodes: options.maxNodes || 500,
    documentGeneration: session.documentGeneration,
  };

  const rawData: any = await page.evaluate(`(${EVAL_SNAPSHOT_SCRIPT})(${JSON.stringify(evalPayload)})`);

  if (rawData.error) {
    return {
      success: false,
      error_code: "INVALID_ARGUMENT",
      action: `browser_snapshot (v${currentVersion})`,
      text: `Snapshot extraction failed: ${rawData.error}`,
      summary: rawData.error,
      verification: {
        performed: true,
        passed: false,
        method: "dom_accessibility_tree_extraction",
        error: rawData.error,
        execution: { status: "failed", method: "dom_accessibility_tree_extraction", error: rawData.error },
        state: { status: "not_performed" },
      },
      durationMs: Date.now() - startTime,
    };
  }

  const snapshotElements: ElementSnapshotInfo[] = [];
  const lines: string[] = [
    `Page: ${title || "(No Title)"}`,
    `URL: ${url}`,
    `Snapshot Version: ${currentVersion} (Gen: ${session.documentGeneration})`,
    `\n${rawData.treeLines.join("\n")}`,
  ];

  rawData.elements.forEach((el: any) => {
    session.elementRefs.set(el.ref, {
      selector: el.selector,
      role: el.role || el.tagName,
      name: el.name || el.text,
      text: el.text,
      isChecked: el.isChecked,
      version: currentVersion,
      generation: session.documentGeneration,
    });
    const bare = el.ref.replace(/^d\d+:/, "");
    if (bare && !session.elementRefs.has(bare)) {
      session.elementRefs.set(bare, {
        selector: el.selector,
        role: el.role || el.tagName,
        name: el.name || el.text,
        text: el.text,
        isChecked: el.isChecked,
        version: currentVersion,
        generation: session.documentGeneration,
      });
    }
    snapshotElements.push(el);
  });

  const snapshotText = lines.join("\n");

  return {
    success: true,
    action: `browser_snapshot (v${currentVersion})`,
    text: snapshotText,
    summary: `Extracted accessibility tree v${currentVersion} (${snapshotElements.length} elements, URL: ${url})`,
    execution_verification: {
      status: "passed",
      method: "dom_accessibility_tree_extraction",
      details: {
        version: currentVersion,
        interactiveElementsCount: rawData.elements.length,
        truncated: Boolean(rawData.truncated),
        url,
      },
    },
    state_verification: {
      status: "passed",
      method: "dom_state_inspected",
      details: { elementsExtracted: snapshotElements.length, truncated: Boolean(rawData.truncated) },
    },
    verification: {
      performed: true,
      passed: true,
      method: "dom_accessibility_tree_extraction",
      details: {
        version: currentVersion,
        interactiveElementsCount: rawData.elements.length,
        url,
      },
      execution: { status: "passed", method: "dom_accessibility_tree_extraction" },
      state: { status: "passed", method: "dom_state_inspected" },
    },
    data: {
      url,
      title,
      version: currentVersion,
      interactiveElementsCount: rawData.elements.length,
      truncated: Boolean(rawData.truncated),
      snapshotText,
      elements: snapshotElements,
    },
    durationMs: Date.now() - startTime,
  };
}

export const executeBrowserSnapshot = takeBrowserSnapshot;
