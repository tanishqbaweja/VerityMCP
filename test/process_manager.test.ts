import { describe, it } from "node:test";
import assert from "node:assert";
import { ProcessManager } from "../src/shell/process_manager.js";

describe("DevSpace 4.0 Process Runtime", () => {
  it("executes a synchronous command and captures stdout", async () => {
    const pm = new ProcessManager();
    const res = await pm.execCommand({
      command: 'echo "Hello DevSpace 4.0"',
      cwd: process.cwd(),
      shell: "powershell",
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.exitCode, 0);
    assert.ok(res.stdout?.includes("Hello DevSpace 4.0"));
    assert.strictEqual(res.verification.passed, true);
  });

  it("PREVENTS DevSpace 3.0 background task empty output bug", async () => {
    const pm = new ProcessManager();
    // Run background command in powershell that produces output
    const res = await pm.execCommand({
      command: 'Write-Output "DevSpace 4.0 Background Output Test"; Start-Sleep -Milliseconds 100',
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
    // DevSpace 3.0 returned "" here! DevSpace 4.0 MUST capture durable output!
    assert.ok(
      readRes.stdout.includes("DevSpace 4.0 Background Output Test"),
      `Expected output to contain test string, but got: "${readRes.stdout}"`
    );
    assert.strictEqual(readRes.data?.isComplete, true);
    assert.strictEqual(readRes.data?.exitCode, 0);
  });
});
