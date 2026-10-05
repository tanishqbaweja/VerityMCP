import { describe, it } from "node:test";
import assert from "node:assert";
import { detectShells, resolveShellCommand } from "../src/shell/shell_detector.js";
import { processManager } from "../src/shell/process_manager.js";

describe("VerityMCP Shell Detection & Real Execution Suite", () => {
  it("detects Git Bash, PowerShell, and cmd with verified health checks", () => {
    const shells = detectShells(true);
    assert.strictEqual(shells.powershell.available, true);
    assert.strictEqual(shells.cmd.available, true);
    assert.strictEqual(shells.gitBash.available, true);
    assert.strictEqual(shells.gitBash.status, "healthy");
    assert.ok(shells.gitBash.executable.toLowerCase().includes("bash.exe"));
    assert.ok(shells.gitBash.version?.includes("bash"));

    // WSL should accurately report not functional if no bash
    if (!shells.wsl.available) {
      assert.strictEqual(shells.wsl.status, "unavailable");
      assert.ok(shells.wsl.healthProbe?.reason);
    }
  });

  it("resolves bash and git-bash to real Git Bash on Windows", () => {
    const bashResolved = resolveShellCommand("bash");
    assert.strictEqual(bashResolved.shellType, "git-bash");
    assert.ok(bashResolved.shell.toLowerCase().includes("bash.exe"));
    assert.deepStrictEqual(bashResolved.argsPrefix, ["-c"]);

    const gitBashResolved = resolveShellCommand("git-bash");
    assert.strictEqual(gitBashResolved.shellType, "git-bash");
    assert.ok(gitBashResolved.shell.toLowerCase().includes("bash.exe"));
  });

  it("executes real command via PowerShell", async () => {
    const res = await processManager.execCommand({
      command: "Write-Output verity-powershell",
      shell: "powershell",
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.exitCode, 0);
    assert.ok(res.stdout?.includes("verity-powershell"));
  });

  it("executes real command via cmd.exe", async () => {
    const res = await processManager.execCommand({
      command: "echo verity-cmd",
      shell: "cmd",
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.exitCode, 0);
    assert.ok(res.stdout?.includes("verity-cmd"));
  });

  it("executes real command via bash (Git Bash resolution)", async () => {
    const res = await processManager.execCommand({
      command: "echo verity-bash",
      shell: "bash",
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.exitCode, 0);
    assert.ok(res.stdout?.includes("verity-bash"));
  });

  it("executes real command via explicit git-bash", async () => {
    const res = await processManager.execCommand({
      command: "echo verity-gitbash",
      shell: "git-bash",
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.exitCode, 0);
    assert.ok(res.stdout?.includes("verity-gitbash"));
  });
});
