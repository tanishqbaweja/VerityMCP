import { describe, it } from "node:test";
import assert from "node:assert";
import { ProcessManager } from "../src/shell/process_manager.js";

describe("VerityMCP Process Runtime", () => {
  it("executes a synchronous command and captures stdout", async () => {
    const pm = new ProcessManager();
    const res = await pm.execCommand({
      command: 'echo "Hello VerityMCP"',
      cwd: process.cwd(),
      shell: "powershell",
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.exitCode, 0);
    assert.ok(res.stdout?.includes("Hello VerityMCP"));
    assert.strictEqual(res.verification.passed, true);
  });

  it("captures background task output reliably", async () => {
    const pm = new ProcessManager();
    // Run background command in powershell that produces output
    const res = await pm.execCommand({
      command: 'Write-Output "VerityMCP Background Output Test"; Start-Sleep -Milliseconds 700',
      cwd: process.cwd(),
      shell: "powershell",
      runInBackground: true,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data?.isBackground, true);
    const sessionId = res.data?.sessionId;
    assert.ok(sessionId);

    // Allow process to run and flush output
    await new Promise((r) => setTimeout(r, 1200));

    // Read process output
    const readRes = pm.readProcessOutput(sessionId, 0);
    assert.strictEqual(readRes.success, true);
    // VerityMCP captures durable output reliably
    assert.ok(
      readRes.stdout.includes("VerityMCP Background Output Test"),
      `Expected output to contain test string, but got: "${readRes.stdout}"`
    );
    assert.strictEqual(readRes.data?.isComplete, true);
    assert.strictEqual(readRes.data?.exitCode, 0);
  });
});
