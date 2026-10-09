import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessManager } from "../src/shell/process_manager.js";
import { detectShells } from "../src/shell/shell_detector.js";

const skipWindowsGitBash = process.platform !== "win32" || !detectShells().gitBash.available;

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

  it("treats an explicitly expected nonzero exit code as verified success", async () => {
    const pm = new ProcessManager();
    const res = await pm.execCommand({
      command: "exit 7",
      cwd: process.cwd(),
      shell: "powershell",
      verify: { exit_code: 7 },
      yieldMs: 5000,
    });

    assert.strictEqual(res.success, true, res.text);
    assert.strictEqual(res.exitCode, 7);
    assert.strictEqual(res.execution_verification?.status, "passed");
    assert.strictEqual(res.state_verification?.status, "passed");
  });

  it("classifies an invalid PowerShell background command on the initial call", { skip: process.platform !== "win32" }, async () => {
    const pm = new ProcessManager();
    const res = await pm.execCommand({
      command: "definitely-not-a-real-command-devspace-regression",
      cwd: process.cwd(),
      shell: "powershell",
      runInBackground: true,
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error_code, "PROCESS_EXITED_IMMEDIATELY");
    assert.strictEqual(res.data?.running, false);
    assert.notStrictEqual(res.data?.exitCode, 0);
  });

  it("classifies an invalid default Git Bash background command on the initial call", { skip: skipWindowsGitBash }, async () => {
    const pm = new ProcessManager();
    const res = await pm.execCommand({
      command: "definitely-not-a-real-command-devspace-gitbash-regression",
      cwd: process.cwd(),
      runInBackground: true,
    });

    assert.strictEqual(res.success, false, res.text);
    assert.strictEqual(res.error_code, "PROCESS_EXITED_IMMEDIATELY");
    assert.strictEqual(res.data?.running, false);
    assert.strictEqual(res.data?.spawn_succeeded, true);
    assert.notStrictEqual(res.data?.exitCode, 0);
  });

  it("delivers a real Windows Ctrl-C to an application SIGINT handler through PowerShell", { skip: process.platform !== "win32" }, async () => {
    const pm = new ProcessManager();
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "devspace-sigint-"));
    try {
      await fs.writeFile(
        path.join(fixture, "interrupt.mjs"),
        [
          "process.on('SIGINT', () => { console.log('SIGINT_HANDLER_OK'); process.exit(0); });",
          "console.log('READY_FOR_SIGINT');",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8"
      );

      const started = await pm.execCommand({
        command: "node interrupt.mjs",
        cwd: fixture,
        shell: "powershell",
        runInBackground: true,
      });
      assert.strictEqual(started.success, true, started.text);
      const sessionId = started.data?.sessionId;
      assert.ok(sessionId);

      const before = pm.readProcessOutput(sessionId, 0);
      assert.ok(before.stdout.includes("READY_FOR_SIGINT"), before.output);

      const interrupted = await pm.interruptProcess(sessionId, 5000);
      assert.strictEqual(interrupted.success, true, interrupted.text);
      assert.strictEqual(interrupted.data?.delivery_method, "windows_private_console_ctrl_c");
      assert.strictEqual(interrupted.data?.process_exited, true);

      const after = pm.readProcessOutput(sessionId, 0);
      assert.ok(after.stdout.includes("SIGINT_HANDLER_OK"), after.output);
      assert.strictEqual(after.data?.isComplete, true);
      assert.notStrictEqual(after.data?.exitCode, null);
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it("preserves expected nonzero exit codes through the Windows Git Bash PTY helper", { skip: skipWindowsGitBash }, async () => {
    const pm = new ProcessManager();
    const res = await pm.execCommand({
      command: "exit 7",
      cwd: process.cwd(),
      shell: "git-bash",
      verify: { exit_code: 7 },
    });

    assert.strictEqual(res.success, true, res.text);
    assert.strictEqual(res.exitCode, 7);
    assert.strictEqual(res.stderr?.includes("DEVSPACE_PTY_EXIT"), false, res.stderr);
    assert.strictEqual(res.execution_verification?.status, "passed");
  });

  it("delivers terminal Ctrl-C through Windows Git Bash to an application SIGINT handler", { skip: skipWindowsGitBash }, async () => {
    const pm = new ProcessManager();
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "devspace-gitbash-sigint-"));
    try {
      await fs.writeFile(
        path.join(fixture, "interrupt.mjs"),
        [
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', d => console.log('GITBASH_STDIN_OK:' + d.trim()));",
          "process.on('SIGINT', () => { console.log('SIGINT_HANDLER_GITBASH_OK'); process.exit(0); });",
          "console.log('READY_FOR_GITBASH_SIGINT');",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8"
      );

      const started = await pm.execCommand({
        command: "node interrupt.mjs",
        cwd: fixture,
        shell: "git-bash",
        runInBackground: true,
      });
      assert.strictEqual(started.success, true, started.text);
      const sessionId = started.data?.sessionId;
      assert.ok(sessionId);

      await new Promise((resolve) => setTimeout(resolve, 250));
      const before = pm.readProcessOutput(sessionId, 0);
      assert.ok(before.stdout.includes("READY_FOR_GITBASH_SIGINT"), before.output);

      const stdinWrite = await pm.writeStdin(sessionId, "PTY_INPUT_LINE");
      assert.strictEqual(stdinWrite.success, true, stdinWrite.text);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const afterInput = pm.readProcessOutput(sessionId, 0);
      assert.ok(afterInput.stdout.includes("GITBASH_STDIN_OK:PTY_INPUT_LINE"), afterInput.output);

      const interrupted = await pm.interruptProcess(sessionId, 5000);
      assert.strictEqual(interrupted.success, true, interrupted.text);
      assert.strictEqual(interrupted.data?.delivery_method, "windows_pty_ctrl_c");
      assert.strictEqual(interrupted.data?.process_exited, true);

      const after = pm.readProcessOutput(sessionId, 0);
      assert.ok(after.stdout.includes("SIGINT_HANDLER_GITBASH_OK"), after.output);
      assert.strictEqual(after.stderr.includes("DEVSPACE_PTY_EXIT"), false, after.stderr);
      assert.strictEqual(after.data?.isComplete, true);
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });
});
