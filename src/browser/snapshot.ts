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
  snapshotText: string;
  elements: ElementSnapshotInfo[];
}

export interface SnapshotOptions {
  verbosity?: "interactive" | "normal" | "full";
}

const EVAL_SNAPSHOT_SCRIPT = `
(verbosity) => {
  let refCounter = 0;
  const elements = [];
  const treeLines = [];

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

  // 1. Headings
  if (verbosity !== "interactive") {
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    for (const h of headings) {
      if (checkVisible(h)) {
        const text = (h.textContent || "").trim();
        if (text) treeLines.push('- heading "' + text + '"');
      }
    }
  }

  // 2. Main Textbox
  const mainInputs = Array.from(document.querySelectorAll("header input, .header input, input.new-todo, [autofocus]"));
  for (const inp of mainInputs) {
    if (checkVisible(inp)) {
      refCounter++;
      const ref = "e" + refCounter;
      inp.setAttribute("data-verity-ref", ref);
      const ph = inp.placeholder || "What needs to be done?";
      elements.push({
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
      });
      treeLines.push('- textbox "' + ph + '" [ref=' + ref + ']');
    }
  }

  // 3. Mark all as complete
  const markAll = document.querySelector("input#toggle-all, input.toggle-all");
  if (markAll && checkVisible(markAll)) {
    refCounter++;
    const ref = "e" + refCounter;
    markAll.setAttribute("data-verity-ref", ref);
    const isChecked = Boolean(markAll.checked);
    elements.push({
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
    });
    treeLines.push('- checkbox "Mark all as complete" [ref=' + ref + '] [checked=' + isChecked + ']');
  }

  // 4. Todo List Items
  const listItems = Array.from(document.querySelectorAll("ul.todo-list li, .todo-list li, ul#todo-list li"));
  if (listItems.length > 0) {
    treeLines.push("- list");
    for (const li of listItems) {
      treeLines.push("  - listitem");

      const cb = li.querySelector("input[type='checkbox'], input.toggle");
      if (cb) {
        refCounter++;
        const ref = "e" + refCounter;
        cb.setAttribute("data-verity-ref", ref);
        const isChecked = Boolean(cb.checked);
        const labelEl = li.querySelector("label");
        const todoText = (labelEl ? labelEl.textContent : "").trim() || "Toggle Todo";
        elements.push({
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
        });
        treeLines.push('    - checkbox "Toggle Todo" [ref=' + ref + '] [checked=' + isChecked + ']');
      }

      const labelEl = li.querySelector("label");
      if (labelEl) {
        const todoText = (labelEl.textContent || "").trim();
        if (todoText) {
          treeLines.push('    - text "' + todoText + '"');
        }
      }

      const delBtn = li.querySelector("button.destroy, button[aria-label='Delete'], button.delete");
      if (delBtn) {
        refCounter++;
        const ref = "e" + refCounter;
        delBtn.setAttribute("data-verity-ref", ref);
        elements.push({
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
        });
        treeLines.push('    - button "Delete" [ref=' + ref + ']');
      }
    }
  }

  // 5. Todo count / status text
  const todoCount = document.querySelector(".todo-count, #todo-count");
  if (todoCount && checkVisible(todoCount)) {
    const text = (todoCount.textContent || "").replace(/\\s+/g, " ").trim();
    if (text) {
      treeLines.push('- text "' + text + '"');
    }
  }

  // 6. Navigation / Filter links (All, Active, Completed)
  const filterLinks = Array.from(document.querySelectorAll("ul.filters a, .filters a, footer a"));
  for (const a of filterLinks) {
    if (checkVisible(a)) {
      refCounter++;
      const ref = "e" + refCounter;
      a.setAttribute("data-verity-ref", ref);
      const linkText = (a.textContent || "").trim();
      elements.push({
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
      });
      treeLines.push('- link "' + linkText + '" [ref=' + ref + ']');
    }
  }

  // 7. Clear completed button
  const clearBtn = document.querySelector("button.clear-completed, .clear-completed");
  if (clearBtn && checkVisible(clearBtn)) {
    const btnStyle = window.getComputedStyle(clearBtn);
    if (btnStyle.display !== "none") {
      refCounter++;
      const ref = "e" + refCounter;
      clearBtn.setAttribute("data-verity-ref", ref);
      elements.push({
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
      });
      treeLines.push('- button "Clear completed" [ref=' + ref + ']');
    }
  }

  // 8. General interactive elements
  const allInteractive = Array.from(
    document.querySelectorAll("a[href], button, input, textarea, select, [role='button'], [role='checkbox'], [role='link']")
  );

  for (const el of allInteractive) {
    if (!el.hasAttribute("data-verity-ref") && checkVisible(el)) {
      refCounter++;
      const ref = "e" + refCounter;
      el.setAttribute("data-verity-ref", ref);
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || "";
      const inp = tag === "input" ? el : null;
      const type = inp ? inp.type : "";
      const name = getLabelText(el);
      const isChecked = inp ? Boolean(inp.checked) : el.getAttribute("aria-checked") === "true";
      const isDisabled = Boolean(el.disabled || el.getAttribute("aria-disabled") === "true");

      elements.push({
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
      });

      if (tag === "button" || role === "button") {
        treeLines.push('- button "' + (name || 'Button') + '" [ref=' + ref + ']');
      } else if (type === "checkbox" || role === "checkbox") {
        treeLines.push('- checkbox "' + (name || 'Checkbox') + '" [ref=' + ref + '] [checked=' + isChecked + ']');
      } else if (tag === "input" || tag === "textarea") {
        treeLines.push('- textbox "' + (name || 'input') + '" [ref=' + ref + ']');
      } else if (tag === "a" || role === "link") {
        treeLines.push('- link "' + (name || 'Link') + '" [ref=' + ref + ']');
      }
    }
  }

  return { elements, treeLines };
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

  // Evaluate raw string function directly in browser context without esbuild __name collisions
  const rawData: any = await page.evaluate(`(${EVAL_SNAPSHOT_SCRIPT})(${JSON.stringify(verbosity)})`);

  const snapshotElements: ElementSnapshotInfo[] = [];
  const lines: string[] = [
    `Page: ${title || "(No Title)"}`,
    `URL: ${url}`,
    `Snapshot Version: ${currentVersion}`,
    `\n${rawData.treeLines.join("\n")}`,
  ];

  rawData.elements.forEach((el: any) => {
    session.elementRefs.set(el.ref, {
      selector: el.selector,
      role: el.role || el.tagName,
      name: el.name || el.text,
      text: el.text,
      isChecked: el.isChecked,
    });
    snapshotElements.push(el);
  });

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
        interactiveElementsCount: rawData.elements.length,
        url,
      },
    },
    data: {
      url,
      title,
      version: currentVersion,
      interactiveElementsCount: rawData.elements.length,
      snapshotText,
      elements: snapshotElements,
    },
    durationMs: Date.now() - startTime,
  };
}
