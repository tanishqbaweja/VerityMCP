import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { executeApplyPatch } from "../src/patcher/apply_patch.js";

describe("VerityMCP Verified Patch Engine", () => {
  it("applies and verifies a valid Codex patch", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "verity-patch-test-"));
    const testFile = path.join(tmpDir, "README.md");
    await fs.writeFile(testFile, "# Original README\nThis is line 2.\nThis is line 3.\n", "utf-8");

    const patchText = `*** Begin Patch
*** Update File: README.md
@@ -1,3 +1,3 @@
 # Original README
-This is line 2.
+This is line 2 updated.
 This is line 3.
*** End Patch`;

    const res = await executeApplyPatch({
      workspaceRoot: tmpDir,
      patch: patchText,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.verification.passed, true);
    assert.deepStrictEqual(res.data?.filesModified, ["README.md"]);

    const newContent = await fs.readFile(testFile, "utf-8");
    assert.ok(newContent.includes("This is line 2 updated."));

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("PREVENTS false-success defect (update with no hunks)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "verity-false-success-"));
    const testFile = path.join(tmpDir, "README.md");
    await fs.writeFile(testFile, "# Original README\nUnchanged text.\n", "utf-8");

    // Defective patch with Update File header but NO hunks
    const defectivePatch = `*** Begin Patch
*** Update File: README.md
*** End Patch`;

    const res = await executeApplyPatch({
      workspaceRoot: tmpDir,
      patch: defectivePatch,
    });

    // Refuse false success when no hunks are provided
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.verification.passed, false);
    assert.ok(res.text.includes("No diff hunks provided") || res.text.includes("Failed"));

    // Verify file on disk is untouched
    const diskContent = await fs.readFile(testFile, "utf-8");
    assert.strictEqual(diskContent, "# Original README\nUnchanged text.\n");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("handles unified diff format with verified readback", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "verity-unidiff-"));
    const testFile = path.join(tmpDir, "app.ts");
    await fs.writeFile(testFile, "const x = 1;\nconst y = 2;\n", "utf-8");

    const unidiff = `--- a/app.ts
+++ b/app.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 42;
`;

    const res = await executeApplyPatch({
      workspaceRoot: tmpDir,
      patch: unidiff,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.verification.passed, true);

    const updated = await fs.readFile(testFile, "utf-8");
    assert.strictEqual(updated, "const x = 1;\nconst y = 42;\n");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
