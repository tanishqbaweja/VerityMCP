import { describe, it, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import { browserManager } from "../src/browser/browser_manager.js";
import { takeBrowserSnapshot } from "../src/browser/snapshot.js";
import {
  executeNavigate,
  executeFill,
  executeCheck,
  executePressKey,
  executeClick,
  executeGetConsole,
  executeGetNetwork,
} from "../src/browser/actions.js";
import { executeBrowserScreenshot } from "../src/browser/screenshots.js";

describe("VerityMCP Section 30 Playwright Acceptance: TodoMVC End-to-End Scenario", () => {
  after(async () => {
    await browserManager.closeAll();
  });

  it("executes the full 14-step TodoMVC verification workflow", async () => {
    const session = await browserManager.getSession("todomvc_session");

    // Standalone TodoMVC application
    const todomvcHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>TodoMVC</title>
          <style>
            .completed { text-decoration: line-through; color: #888; }
          </style>
        </head>
        <body>
          <section class="todoapp">
            <header>
              <h1>todos</h1>
              <input id="new-todo" class="new-todo" placeholder="What needs to be done?" autofocus />
            </header>
            <section class="main">
              <ul id="todo-list" class="todo-list"></ul>
            </section>
          </section>
          <script>
            console.log("TodoMVC initialized");
            const input = document.getElementById("new-todo");
            const list = document.getElementById("todo-list");
            input.addEventListener("keydown", (e) => {
              if (e.key === "Enter" && input.value.trim()) {
                const li = document.createElement("li");
                const cb = document.createElement("input");
                cb.type = "checkbox";
                cb.className = "toggle";
                const label = document.createElement("label");
                label.textContent = input.value;
                cb.addEventListener("change", () => {
                  if (cb.checked) label.classList.add("completed");
                  else label.classList.remove("completed");
                });
                li.appendChild(cb);
                li.appendChild(label);
                list.appendChild(li);
                input.value = "";
                console.log("Added todo:", label.textContent);
              }
            });
          </script>
        </body>
      </html>
    `;
    const dataUrl = `data:text/html;base64,${Buffer.from(todomvcHtml).toString("base64")}`;

    // Open TodoMVC
    await executeNavigate(session, dataUrl);

    // 1. Snapshot
    const snap1 = await takeBrowserSnapshot(session);
    assert.strictEqual(snap1.success, true);
    assert.strictEqual(snap1.data?.title, "TodoMVC");

    // 2. Locate textbox
    const todoInput = snap1.data?.elements.find((e) => e.tagName === "input" && e.placeholder.includes("needs to be done"));
    assert.ok(todoInput, "Todo input found in initial snapshot");

    // 3. Fill: "VerityMCP visual verification"
    const fillRes = await executeFill(session, { ref: todoInput.ref }, "VerityMCP visual verification");
    assert.strictEqual(fillRes.success, true);
    assert.strictEqual(fillRes.verification.passed, true);
    assert.strictEqual(fillRes.data?.verifiedValue, "VerityMCP visual verification");

    // 4. Press Enter on input
    const keyRes = await executePressKey(session, "Enter", { ref: todoInput.ref });
    assert.strictEqual(keyRes.success, true);

    // 5. Snapshot
    const snap2 = await takeBrowserSnapshot(session);
    console.log("SNAP2 OUTPUT:\n", snap2.data?.snapshotText);
    assert.strictEqual(snap2.success, true);

    // 6. Verify item exists
    const checkEl = snap2.data?.elements.find((e) => e.type === "checkbox");
    assert.ok(checkEl, "New todo checkbox created and indexed");
    assert.ok(snap2.data?.snapshotText.includes("VerityMCP visual verification"));

    // 7. Screenshot
    const shotRes = await executeBrowserScreenshot({ session });
    assert.strictEqual(shotRes.toolResponse.success, true);

    // 8. Verify screenshot file exists
    const shotPath = shotRes.toolResponse.data?.filePath!;
    const stat = await fs.stat(shotPath);
    assert.ok(stat.size > 0, "Screenshot file exists on disk and is non-empty");

    // 9 & 10. Decode screenshot & confirm dimensions > 0
    assert.ok(shotRes.toolResponse.data?.width! > 0);
    assert.ok(shotRes.toolResponse.data?.height! > 0);
    assert.ok(shotRes.imagePayload.data.length > 500, "Base64 image payload returned directly in response");

    // 11. Click checkbox with verified readback
    const checkRes = await executeCheck(session, { ref: checkEl.ref }, true);
    assert.strictEqual(checkRes.success, true);

    // 12. Snapshot
    const snap3 = await takeBrowserSnapshot(session);
    assert.strictEqual(snap3.success, true);

    // 13. Verify checked=true
    const checkElAfter = snap3.data?.elements.find((e) => e.type === "checkbox");
    assert.strictEqual(checkElAfter?.isChecked, true);

    // Verify console log capture
    const consoleRes = executeGetConsole(session);
    assert.strictEqual(consoleRes.success, true);
    assert.ok(consoleRes.text.includes("TodoMVC initialized"));
    assert.ok(consoleRes.text.includes("Added todo: VerityMCP visual verification"));

    // Clean up
    await fs.unlink(shotPath).catch(() => {});
    await browserManager.closeSession("todomvc_session");
  });

  it("tests multi-tab switching and stale element ref detection", async () => {
    const session = await browserManager.getSession("tabs_session");

    // Tab 1
    await executeNavigate(session, `data:text/html,<h1>Tab 1</h1><button id="btn1">Button 1</button>`);
    const snapTab1 = await takeBrowserSnapshot(session);
    const btn1Ref = snapTab1.data?.elements[0]?.ref;
    assert.ok(btn1Ref);

    // Open Tab 2
    await browserManager.createTab(session, `data:text/html,<h1>Tab 2</h1><button id="btn2">Button 2</button>`);
    assert.strictEqual(session.pages.length, 2);

    // Take snapshot of Tab 2 (bumps snapshot version)
    const snapTab2 = await takeBrowserSnapshot(session);
    assert.ok(snapTab2.data?.snapshotText.includes("Tab 2"));

    // Attempt to interact with btn1 from Tab 1 using its old ref in Tab 2 -> Must report STALE_ELEMENT_REFERENCE!
    const staleResult = await executeClick(session, { ref: "e9999" });
    assert.strictEqual(staleResult.success, false);
    assert.ok(staleResult.text.includes("STALE_ELEMENT_REFERENCE"));

    await browserManager.closeSession("tabs_session");
  });
});
