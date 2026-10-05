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

describe("VerityMCP First-Class Browser Automation Engine", () => {
  after(async () => {
    await browserManager.closeAll();
  });

  it("navigates, snapshots, interacts with form and checkbox, and captures screenshot", async () => {
    const session = await browserManager.getSession("test_session");

    // Load rich interactive HTML page
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>VerityMCP Test Page</title></head>
        <body>
          <h1>Welcome to VerityMCP</h1>
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
    assert.strictEqual(navRes.data?.title, "VerityMCP Test Page");

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

  it("resolves custom relative screenshot path against workspace root and verifies persistence", async () => {
    const session = await browserManager.getSession("test_session_screenshot");
    const testRelPath = ".verity-test-screenshot.png";
    const nestedRelPath = "test-results/browser/nested-shot.png";

    // 1. Test flat relative path
    const shot1 = await executeBrowserScreenshot({
      session,
      outputPath: testRelPath,
    });
    assert.strictEqual(shot1.toolResponse.success, true);
    assert.strictEqual(shot1.toolResponse.verification.passed, true);
    assert.strictEqual(shot1.toolResponse.data?.requestedPath, testRelPath);
    assert.ok(shot1.toolResponse.data?.resolvedPath.endsWith(testRelPath));
    assert.ok(shot1.toolResponse.data?.bytes! > 0);
    assert.ok(shot1.toolResponse.data?.sha256);
    assert.ok(shot1.imagePayload.data.length > 50);

    // Verify file actually exists on disk
    const stat1 = await fs.stat(shot1.toolResponse.data?.resolvedPath!);
    assert.ok(stat1.size > 0);
    await fs.unlink(shot1.toolResponse.data?.resolvedPath!).catch(() => {});

    // 2. Test nested relative path with recursive mkdir
    const shot2 = await executeBrowserScreenshot({
      session,
      outputPath: nestedRelPath,
    });
    assert.strictEqual(shot2.toolResponse.success, true);
    assert.strictEqual(shot2.toolResponse.verification.passed, true);
    assert.strictEqual(shot2.toolResponse.data?.requestedPath, nestedRelPath);
    assert.ok(shot2.toolResponse.data?.resolvedPath.includes("nested-shot.png"));

    const stat2 = await fs.stat(shot2.toolResponse.data?.resolvedPath!);
    assert.ok(stat2.size > 0);
    await fs.unlink(shot2.toolResponse.data?.resolvedPath!).catch(() => {});
    await fs.rm("test-results", { recursive: true, force: true }).catch(() => {});
  });
});

