import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { executeWriteFile } from "../src/filesystem/write_file.js";
import { executeReadFile } from "../src/filesystem/read_file.js";
import { executeEditFile } from "../src/filesystem/edit_file.js";
import {
  executeDeleteFile,
  executeMoveFile,
  executeCopyFile,
} from "../src/filesystem/file_ops.js";
import { executeLocateFiles } from "../src/filesystem/locate_files.js";
import { executeFileMetadata } from "../src/filesystem/file_metadata.js";
import { executeSearchCode } from "../src/discovery/search_code.js";
import { executeGetOutline } from "../src/discovery/get_outline.js";
import { taskStore } from "../src/tasks/task_store.js";
import { observabilityManager } from "../src/observability/diagnostics.js";

describe("DevSpace 4.0 Comprehensive Acceptance Suite", () => {
  it("verifies full filesystem mutations and image read lifecycle", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devspace4-acc-"));

    // 1. write_file with verification
    const writeRes = await executeWriteFile({
      workspaceRoot: tmpDir,
      filePath: "src/sample.ts",
      content: "export const greeting = 'hello world';\nexport function compute() { return 42; }\n",
    });
    assert.strictEqual(writeRes.success, true);
    assert.strictEqual(writeRes.verification.passed, true);

    // 2. read_file with line slicing
    const readSliceRes = await executeReadFile({
      workspaceRoot: tmpDir,
      filePath: "src/sample.ts",
      lineStart: 1,
      lineEnd: 1,
    });
    assert.strictEqual(readSliceRes.toolResponse.success, true);
    assert.strictEqual(readSliceRes.toolResponse.data?.linesRead, 1);
    assert.ok(readSliceRes.toolResponse.text.includes("hello world"));

    // 3. edit_file with verified replacement and unified diff
    const editRes = await executeEditFile({
      workspaceRoot: tmpDir,
      filePath: "src/sample.ts",
      oldString: "return 42;",
      newString: "return 100;",
    });
    assert.strictEqual(editRes.success, true);
    assert.strictEqual(editRes.verification.passed, true);
    assert.ok(editRes.data?.diffPatch.includes("-export function compute() { return 42; }"));
    assert.ok(editRes.data?.diffPatch.includes("+export function compute() { return 100; }"));

    // 4. file_metadata
    const metaRes = await executeFileMetadata({
      workspaceRoot: tmpDir,
      filePath: "src/sample.ts",
    });
    assert.strictEqual(metaRes.success, true);
    assert.strictEqual(metaRes.data?.exists, true);
    assert.strictEqual(metaRes.data?.type, "file");
    assert.ok(metaRes.data?.sha256);

    // 5. copy_file with byte verification
    const copyRes = await executeCopyFile({
      workspaceRoot: tmpDir,
      sourcePath: "src/sample.ts",
      destinationPath: "src/sample_copy.ts",
    });
    assert.strictEqual(copyRes.success, true);
    assert.strictEqual(copyRes.verification.passed, true);

    // 6. move_file with relocation verification
    const moveRes = await executeMoveFile({
      workspaceRoot: tmpDir,
      sourcePath: "src/sample_copy.ts",
      destinationPath: "src/sample_renamed.ts",
    });
    assert.strictEqual(moveRes.success, true);
    assert.strictEqual(moveRes.verification.passed, true);

    // 7. delete_file with existence verification
    const delRes = await executeDeleteFile({
      workspaceRoot: tmpDir,
      filePath: "src/sample_renamed.ts",
    });
    assert.strictEqual(delRes.success, true);
    assert.strictEqual(delRes.verification.passed, true);

    // 8. Image read returning direct visual base64 payload
    // Create a 1x1 valid PNG image buffer
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const pngPath = path.join(tmpDir, "logo.png");
    await fs.writeFile(pngPath, Buffer.from(pngBase64, "base64"));

    const imageReadRes = await executeReadFile({
      workspaceRoot: tmpDir,
      filePath: "logo.png",
    });
    assert.strictEqual(imageReadRes.toolResponse.success, true);
    assert.strictEqual(imageReadRes.toolResponse.data?.isImage, true);
    assert.ok(imageReadRes.imagePayload);
    assert.strictEqual(imageReadRes.imagePayload.mimeType, "image/png");
    assert.strictEqual(imageReadRes.imagePayload.data, pngBase64);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("verifies code intelligence (ripgrep, outline, locate_files)", async () => {
    const root = process.cwd();

    // 1. search_code (ripgrep)
    const searchRes = executeSearchCode({
      workspaceRoot: root,
      query: "createDevSpace4McpServer",
      globFilter: "*.ts",
    });
    assert.strictEqual(searchRes.success, true);
    assert.ok(searchRes.data && searchRes.data.totalMatches >= 1);
    assert.ok(searchRes.data?.matches.some((m) => m.filePath.includes("mcp_tools.ts")));

    // 2. get_outline
    const outlineRes = await executeGetOutline({
      workspaceRoot: root,
      filePath: "src/filesystem/read_file.ts",
    });
    assert.strictEqual(outlineRes.success, true);
    assert.ok(outlineRes.data && outlineRes.data.symbols.length > 0);
    assert.ok(outlineRes.data?.symbols.some((s) => s.name === "executeReadFile"));

    // 3. locate_files
    const locateRes = await executeLocateFiles({
      workspaceRoot: root,
      pattern: "*patch*.ts",
    });
    assert.strictEqual(locateRes.success, true);
    assert.ok(locateRes.data && locateRes.data.totalMatches >= 1);
  });

  it("verifies task planning store and observability diagnostics", async () => {
    // 1. Task lifecycle
    const createRes = taskStore.createTask("DevSpace 4.0 Final Verification", "Run all tests and build");
    assert.strictEqual(createRes.success, true);
    const taskId = createRes.data?.id!;

    const updateRes = taskStore.updateTask(taskId, { status: "completed" });
    assert.strictEqual(updateRes.success, true);
    assert.strictEqual(updateRes.data?.status, "completed");

    const listRes = taskStore.listTasks();
    assert.strictEqual(listRes.success, true);
    assert.ok(listRes.data?.some((t) => t.id === taskId && t.status === "completed"));

    // 2. Observability diagnostics
    const diagRes = observabilityManager.getDiagnostics();
    assert.strictEqual(diagRes.success, true);
    assert.strictEqual(diagRes.verification.passed, true);
    assert.strictEqual(diagRes.data?.version, "4.0.0");
  });
});
