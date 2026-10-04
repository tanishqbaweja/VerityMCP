import { describe, it, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import { browserManager } from "../src/browser/browser_manager.js";
import { takeBrowserSnapshot } from "../src/browser/snapshot.js";
import {
  executeNavigate,
  executeFill,
  executeCheck,
} from "../src/browser/actions.js";
import { executeBrowserScreenshot } from "../src/browser/screenshots.js";

describe("DevSpace 4.0 First-Class Browser Automation Engine", () => {
  after(async () => {
    await browserManager.closeAll();
  });

  it("navigates, snapshots, interacts with form and checkbox, and captures screenshot", async () => {
    const session = await browserManager.getSession("test_session");

    // Load rich interactive HTML page
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>DevSpace 4.0 Test Page</title></head>
        <body>
          <h1>Welcome to DevSpace 4.0</h1>
          <form id="todo-form">
            <label for="task-input">Task Name:</label>
            <input type="text" id="task-input" name="task" placeholder="Enter task..." />
            <br />
            <label for="done-check">Mark Completed:</label>
            <input type="checkbox" id="done-check" name="done" />
            <br />
            <button type="submit" id="submit-btn">Add Task</button>
          </form>
        </body>
      </html>
    `;
    const dataUrl = `data:text/html;base64,${Buffer.from(html).toString("base64")}`;

    // 1. Navigate
    const navRes = await executeNavigate(session, dataUrl);
    assert.strictEqual(navRes.success, true);
    assert.strictEqual(navRes.data?.title, "DevSpace 4.0 Test Page");

    // 2. Snapshot
    const snapRes = await takeBrowserSnapshot(session);
    assert.strictEqual(snapRes.success, true);
    assert.ok(snapRes.data && snapRes.data.interactiveElementsCount >= 3);
    assert.ok(snapRes.data?.snapshotText.includes("Task Name") || snapRes.data?.snapshotText.includes("Enter task"));

    // Find input ref and checkbox ref
    const inputEl = snapRes.data?.elements.find((e) => e.tagName === "input" && e.type === "text");
    const checkEl = snapRes.data?.elements.find((e) => e.tagName === "input" && e.type === "checkbox");

    assert.ok(inputEl, "Text input element found in snapshot");
    assert.ok(checkEl, "Checkbox element found in snapshot");

    // 3. Fill with verified readback
    const fillRes = await executeFill(session, { ref: inputEl.ref }, "Test Todo Item #1");
    assert.strictEqual(fillRes.success, true);
    assert.strictEqual(fillRes.verification.passed, true);
    assert.strictEqual(fillRes.data?.verifiedValue, "Test Todo Item #1");

    // 4. Check checkbox with verified readback
    const checkRes = await executeCheck(session, { ref: checkEl.ref }, true);
    assert.strictEqual(checkRes.success, true);
    assert.strictEqual(checkRes.verification.passed, true);
    assert.strictEqual(checkRes.data?.isChecked, true);

    // 5. Screenshot
    const shotRes = await executeBrowserScreenshot({ session });
    assert.strictEqual(shotRes.toolResponse.success, true);
    assert.strictEqual(shotRes.toolResponse.verification.passed, true);
    assert.ok(shotRes.imagePayload.data.length > 100);
    assert.strictEqual(shotRes.imagePayload.mimeType, "image/png");

    // Clean up screenshot file
    if (shotRes.toolResponse.data?.filePath) {
      await fs.unlink(shotRes.toolResponse.data.filePath).catch(() => {});
    }
  });
});
