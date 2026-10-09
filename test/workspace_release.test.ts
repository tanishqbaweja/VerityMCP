import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace_manager.js";
import { executeLsp } from "../src/discovery/lsp_tool.js";
import { executeSearchCode } from "../src/discovery/search_code.js";

describe("VerityMCP workspace lifecycle", () => {
  it("releases an old workspace root before openWorkspace returns for the new root", async () => {
    const manager = new WorkspaceManager();
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "verity-ws-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "verity-ws-b-"));

    try {
      const sourcePath = path.join(rootA, "sample.ts");
      const source = [
        "export function add(a: number, b: number) { return a + b; }",
        "export const answer = add(20, 22);",
        "",
      ].join("\n");
      await fs.writeFile(sourcePath, source, "utf8");

      const openA = await manager.openWorkspace(rootA, [rootA]);
      assert.strictEqual(openA.success, true);

      const symbol = await executeLsp({
        workspaceRoot: rootA,
        allowedRoots: [rootA],
        operation: "goToDefinition",
        filePath: sourcePath,
        line: 2,
        character: source.split("\n")[1].indexOf("add") + 1,
      });
      assert.strictEqual(symbol.success, true, symbol.text);

      const search = await executeSearchCode({
        workspaceRoot: rootA,
        allowedRoots: [rootA],
        query: "answer",
        dirPath: rootA,
      });
      assert.strictEqual(search.success, true, search.text);

      const openB = await manager.openWorkspace(rootB, [rootB]);
      assert.strictEqual(openB.success, true);
      assert.strictEqual(
        manager.getActiveWorkspaceRoot().toLowerCase(),
        path.resolve(rootB).toLowerCase()
      );

      // The switch is not considered complete until passive workspace-owned resources
      // for A are released. On Windows this must succeed immediately after openWorkspace returns.
      await fs.rm(rootA, { recursive: true, force: true });
      await assert.rejects(fs.stat(rootA));
    } finally {
      await manager.closeWorkspace();
      await fs.rm(rootA, { recursive: true, force: true }).catch(() => {});
      await fs.rm(rootB, { recursive: true, force: true }).catch(() => {});
    }
  });
});
