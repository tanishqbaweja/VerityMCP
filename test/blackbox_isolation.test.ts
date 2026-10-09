import assert from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runBlackboxTest } from "../src/observability/blackbox_test.js";
import { workspaceManager } from "../src/workspace/workspace_manager.js";
import { browserManager } from "../src/browser/browser_manager.js";

describe("VerityMCP Seeded Blackbox Isolation", () => {
  it("does not mutate the shared global active workspace", { timeout: 30_000 }, async () => {
    const sentinel = await fs.mkdtemp(path.join(os.tmpdir(), "verity-blackbox-sentinel-"));
    try {
      const opened = await workspaceManager.openWorkspace(sentinel);
      assert.strictEqual(opened.success, true, opened.text);
      const before = workspaceManager.getActiveWorkspaceRoot();

      const result = await runBlackboxTest({
        seed: "workspace-isolation-regression",
        workspaceRoot: sentinel,
      });

      assert.strictEqual(result.data?.cleanupVerified, true);
      const restoreCheck = result.data?.checks.find(
        (check) => check.name === "blackbox_caller_workspace_restored"
      );
      assert.strictEqual(restoreCheck?.passed, true, result.text);
      assert.strictEqual(
        workspaceManager.getActiveWorkspaceRoot().toLowerCase(),
        before.toLowerCase()
      );
      assert.strictEqual(
        path.resolve(before).toLowerCase(),
        path.resolve(sentinel).toLowerCase()
      );
    } finally {
      await browserManager.closeAll().catch(() => {});
      const current = workspaceManager.getWorkspace();
      if (current) {
        await workspaceManager.closeWorkspace(current.id).catch(() => {});
      }
      await fs.rm(sentinel, { recursive: true, force: true }).catch(() => {});
    }
  });
});
