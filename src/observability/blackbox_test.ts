import os from "node:os";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import assert from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { getServerRoot } from "../storage/paths.js";
import { WorkspaceManager, workspaceManager } from "../workspace/workspace_manager.js";
import { processManager } from "../shell/process_manager.js";
import { browserManager } from "../browser/browser_manager.js";
import { runManager } from "../runs/run_manager.js";
import { executeWriteFile } from "../filesystem/write_file.js";
import { executeEditFile } from "../filesystem/edit_file.js";
import { executeCopyFile, executeMoveFile, executeDeleteFile } from "../filesystem/file_ops.js";
import { executeGetOutline } from "../discovery/get_outline.js";
import { executeSearchCode } from "../discovery/search_code.js";
import { executeLsp } from "../discovery/lsp_tool.js";
import { executeEnterWorktree, executeExitWorktree } from "../git/worktrees.js";
import { executeListWindows, executeDesktopScreenshot, executeFocusWindow } from "../desktop/desktop_control.js";
import { taskStore } from "../tasks/task_store.js";
import { navigateAndVerify, executePdf, executeTraceStop } from "../browser/actions.js";
import { executeBrowserScreenshot } from "../browser/screenshots.js";
import { activityStream } from "./activity_stream.js";
import type { StandardToolResponse } from "../types/index.js";

export interface BlackboxCheck {
  name: string;
  category: string;
  passed: boolean;
  durationMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface BlackboxTestResult {
  allPassed: boolean;
  blackbox_seed: string;
  fixture_path: string;
  checksTotal: number;
  checksPassed: number;
  checks: BlackboxCheck[];
  cleanupVerified: boolean;
}

function createPrng(seedStr: string) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let s = h >>> 0;
  return function next() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function runBlackboxTest(options?: {
  seed?: string;
  workspaceRoot?: string;
}): Promise<StandardToolResponse<BlackboxTestResult>> {
  const startTime = Date.now();
  const seed = (options?.seed && options.seed.trim()) || `seed_${Date.now()}`;
  const prng = createPrng(seed);

  const randSuffix = Math.floor(prng() * 1000000).toString(16);
  const serverRoot = getServerRoot();
  const fixtureBase = options?.workspaceRoot
    ? path.resolve(options.workspaceRoot)
    : path.join(serverRoot, ".verity", "test-fixtures");
  const fixtureDir = path.join(
    fixtureBase,
    `bb_${seed.replace(/[^a-zA-Z0-9_-]/g, "_")}_${randSuffix}`
  );

  const checks: BlackboxCheck[] = [];

  activityStream.emit({
    type: "action_started",
    title: `Running seeded black-box robustness battery (seed: ${seed})`,
    purpose: "Probe orthogonal subsystems with dynamic fixtures, reproducible PRNG data, and strict cleanup verification",
    tool: "verity_blackbox_test",
  });

  const prevActiveRun = runManager.getActiveRun();
  const prevWorkspaceRoot = workspaceManager.getWorkspace()?.root;
  runManager.setActiveRun(null);

  const restoreCallerWorkspace = async (): Promise<boolean> => {
    try {
      const active = workspaceManager.getWorkspace();

      if (prevWorkspaceRoot && fsSync.existsSync(prevWorkspaceRoot)) {
        const currentRoot = active?.root ? path.resolve(active.root).toLowerCase() : undefined;
        const previousRoot = path.resolve(prevWorkspaceRoot).toLowerCase();
        if (currentRoot !== previousRoot) {
          const restored = await workspaceManager.openWorkspace(prevWorkspaceRoot);
          if (!restored.success) return false;
        }
        return path.resolve(workspaceManager.getActiveWorkspaceRoot()).toLowerCase() === previousRoot;
      }

      // The caller had no workspace (or its former root no longer exists). Do not
      // leave an internal fixture as the global active workspace.
      if (active) {
        await workspaceManager.closeWorkspace(active.id);
      }
      return prevWorkspaceRoot ? false : workspaceManager.getWorkspace() === undefined;
    } catch {
      return false;
    }
  };

  await fs.mkdir(fixtureDir, { recursive: true });

  try {
    // 1. Filesystem: nested directories, write, copy, move, delete with byte/hash verification
    const fsStart = Date.now();
    try {
      const nestedDir = path.join(fixtureDir, `nested_${randSuffix}`, `sub_${Math.floor(prng() * 9999)}`);
      await fs.mkdir(nestedDir, { recursive: true });
      const testFilePath = path.join(nestedDir, `payload_${randSuffix}.txt`);
      const payloadContent = `BlackBox dynamic payload seed=${seed} rand=${randSuffix}\nLine 2 content`;

      const writeRes = await executeWriteFile({
        workspaceRoot: fixtureDir,
        allowedRoots: [fixtureDir],
        filePath: testFilePath,
        content: payloadContent,
      });
      const copyDestPath = path.join(nestedDir, `payload_copy_${randSuffix}.txt`);
      const copyRes = await executeCopyFile({
        workspaceRoot: fixtureDir,
        allowedRoots: [fixtureDir],
        sourcePath: testFilePath,
        destinationPath: copyDestPath,
      });
      const moveDestPath = path.join(nestedDir, `payload_moved_${randSuffix}.txt`);
      const moveRes = await executeMoveFile({
        workspaceRoot: fixtureDir,
        allowedRoots: [fixtureDir],
        sourcePath: copyDestPath,
        destinationPath: moveDestPath,
      });

      const copySrcExistsAfterMove = fsSync.existsSync(copyDestPath);
      const movedExists = fsSync.existsSync(moveDestPath);
      const movedContent = await fs.readFile(moveDestPath, "utf-8");

      const delRes1 = await executeDeleteFile({
        workspaceRoot: fixtureDir,
        allowedRoots: [fixtureDir],
        filePath: testFilePath,
      });
      const delRes2 = await executeDeleteFile({
        workspaceRoot: fixtureDir,
        allowedRoots: [fixtureDir],
        filePath: moveDestPath,
      });

      const passed =
        writeRes.success &&
        copyRes.success &&
        moveRes.success &&
        !copySrcExistsAfterMove &&
        movedExists &&
        movedContent === payloadContent &&
        delRes1.success &&
        delRes2.success &&
        !fsSync.existsSync(testFilePath) &&
        !fsSync.existsSync(moveDestPath);

      checks.push({
        name: "fs_nested_write_copy_move_delete",
        category: "filesystem",
        passed,
        durationMs: Date.now() - fsStart,
        details: { testFilePath, copyDestPath, moveDestPath },
        error: passed ? undefined : "Filesystem sequence failed validation",
      });
    } catch (err: any) {
      checks.push({
        name: "fs_nested_write_copy_move_delete",
        category: "filesystem",
        passed: false,
        durationMs: Date.now() - fsStart,
        error: err.message,
      });
    }

    // 2. Filesystem: stale hash precondition guard
    const staleStart = Date.now();
    try {
      const staleFile = path.join(fixtureDir, `stale_guard_${randSuffix}.txt`);
      await fs.writeFile(staleFile, "Original content for stale hash guard", "utf-8");
      const badHash = "0000000000000000000000000000000000000000000000000000000000000000";

      const editRes = await executeEditFile({
        workspaceRoot: fixtureDir,
        allowedRoots: [fixtureDir],
        filePath: staleFile,
        oldString: "Original content",
        newString: "Mutated content",
        expectedSha256: badHash,
      });

      const blockedCorrectly = !editRes.success && (
        editRes.error_code === "FILE_CHANGED_SINCE_READ" ||
        editRes.error_code === "HASH_PRECONDITION_FAILED" ||
        editRes.text.includes("hash mismatch") ||
        editRes.text.includes("precondition")
      );

      await fs.unlink(staleFile).catch(() => {});

      checks.push({
        name: "fs_stale_hash_precondition_guard",
        category: "filesystem",
        passed: blockedCorrectly,
        durationMs: Date.now() - staleStart,
        details: { errorCode: editRes.error_code },
        error: blockedCorrectly ? undefined : "Stale hash edit was not safely rejected",
      });
    } catch (err: any) {
      checks.push({
        name: "fs_stale_hash_precondition_guard",
        category: "filesystem",
        passed: false,
        durationMs: Date.now() - staleStart,
        error: err.message,
      });
    }

    // 3. Code Intelligence: fresh TypeScript symbols and outline
    const codeStart = Date.now();
    try {
      const tsFile = path.join(fixtureDir, `Service_${randSuffix}.ts`);
      const tsCode = `
export interface IWorker_${randSuffix} {
  processTask(taskId: string): Promise<boolean>;
}

export class TaskProcessor_${randSuffix} implements IWorker_${randSuffix} {
  private id: string;
  constructor(id: string) {
    this.id = id;
  }
  public async processTask(taskId: string): Promise<boolean> {
    return taskId.length > 0;
  }
}
`;
      await fs.writeFile(tsFile, tsCode, "utf-8");

      const outlineRes = await executeGetOutline({
        workspaceRoot: fixtureDir,
        allowedRoots: [fixtureDir],
        filePath: tsFile,
      });
      const outlineText = outlineRes.text || JSON.stringify(outlineRes.data || "");
      const hasInterface = outlineText.includes(`IWorker_${randSuffix}`);
      const hasClass = outlineText.includes(`TaskProcessor_${randSuffix}`);
      const hasMethod = outlineText.includes("processTask");

      const searchRes = executeSearchCode({
        workspaceRoot: fixtureDir,
        allowedRoots: [fixtureDir],
        query: `TaskProcessor_${randSuffix}`,
        dirPath: fixtureDir,
      });
      const searchFound = Boolean(
        searchRes.success &&
        (searchRes.text.includes(path.basename(tsFile)) ||
          (searchRes.data?.matches && searchRes.data.matches.length > 0))
      );

      await fs.unlink(tsFile).catch(() => {});

      const passed = outlineRes.success && hasInterface && hasClass && hasMethod && searchFound;
      checks.push({
        name: "code_intelligence_symbols_and_outline",
        category: "code_intelligence",
        passed,
        durationMs: Date.now() - codeStart,
        details: { hasInterface, hasClass, hasMethod, searchFound },
        error: passed ? undefined : "Failed extracting outline or searching fresh TypeScript symbols",
      });
    } catch (err: any) {
      checks.push({
        name: "code_intelligence_symbols_and_outline",
        category: "code_intelligence",
        passed: false,
        durationMs: Date.now() - codeStart,
        error: err.message,
      });
    }

    // 4. Process Control: interactive stdin echo & tree kill
    const procStart = Date.now();
    try {
      const echoScript = path.join(fixtureDir, `echo_${randSuffix}.cjs`);
      await fs.writeFile(
        echoScript,
        `process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => {
  process.stdout.write('ECHO_REPLY:' + chunk);
});
setInterval(() => {}, 1000);`,
        "utf-8"
      );

      const execRes = await processManager.execCommand({
        command: `node "${echoScript}"`,
        cwd: fixtureDir,
        runInBackground: true,
      });

      let echoWorked = false;
      if (execRes.success && execRes.data?.sessionId) {
        const pSessionId = execRes.data.sessionId;
        const msg = `hello_blackbox_${randSuffix}\n`;
        await processManager.writeStdin(pSessionId, msg);
        await new Promise((r) => setTimeout(r, 200));

        const readRes = await processManager.readProcessOutput(pSessionId);
        echoWorked = (readRes.stdout || readRes.text || "").includes(`ECHO_REPLY:hello_blackbox_${randSuffix}`);

        await processManager.killProcess(pSessionId);
      }

      await fs.unlink(echoScript).catch(() => {});

      checks.push({
        name: "process_stdin_echo_and_tree_kill",
        category: "process",
        passed: echoWorked,
        durationMs: Date.now() - procStart,
        details: { echoWorked },
        error: echoWorked ? undefined : "Process stdin echo interaction failed",
      });
    } catch (err: any) {
      checks.push({
        name: "process_stdin_echo_and_tree_kill",
        category: "process",
        passed: false,
        durationMs: Date.now() - procStart,
        error: err.message,
      });
    }

    // 5. Git: worktree enter, dirty safety guard, and forced exit
    const gitStart = Date.now();
    try {
      const repoDir = path.join(fixtureDir, `git_repo_${randSuffix}`);
      await fs.mkdir(repoDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main", repoDir], { encoding: "utf-8", windowsHide: true });
      execFileSync("git", ["-C", repoDir, "config", "user.name", "VerityBlackbox"], { encoding: "utf-8", windowsHide: true });
      execFileSync("git", ["-C", repoDir, "config", "user.email", "blackbox@verity.local"], { encoding: "utf-8", windowsHide: true });
      await fs.writeFile(path.join(repoDir, "README.md"), "# Blackbox Git Repo\n", "utf-8");
      execFileSync("git", ["-C", repoDir, "add", "README.md"], { encoding: "utf-8", windowsHide: true });
      execFileSync("git", ["-C", repoDir, "commit", "-m", "initial commit"], { encoding: "utf-8", windowsHide: true });

      await workspaceManager.openWorkspace(repoDir, [repoDir]);

      const enterRes = await executeEnterWorktree({
        name: `bb_${randSuffix}`,
      });

      let dirtyBlocked = false;
      let forceExitWorked = false;

      if (enterRes.success && enterRes.data?.worktreePath) {
        const wtPath = enterRes.data.worktreePath;
        // Create an untracked dirty file in the worktree
        await fs.writeFile(path.join(wtPath, "dirty.txt"), "uncommitted worktree change", "utf-8");

        // Attempt clean removal without force
        const exitCleanRes = await executeExitWorktree({
          action: "remove",
          force: false,
        });
        dirtyBlocked = !exitCleanRes.success && exitCleanRes.error_code === "WORKTREE_DIRTY";

        // Forced removal
        const exitForceRes = await executeExitWorktree({
          action: "remove",
          force: true,
        });
        forceExitWorked = exitForceRes.success;
      }

      const callerWorkspaceRestored = await restoreCallerWorkspace();

      await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});

      const passed = enterRes.success && dirtyBlocked && forceExitWorked && callerWorkspaceRestored;
      checks.push({
        name: "git_worktree_dirty_guard_and_lifecycle",
        category: "git",
        passed,
        durationMs: Date.now() - gitStart,
        details: { enterOk: enterRes.success, dirtyBlocked, forceExitWorked, callerWorkspaceRestored },
        error: passed ? undefined : "Git worktree dirty guard, exit, or caller-workspace restoration failed",
      });
    } catch (err: any) {
      checks.push({
        name: "git_worktree_dirty_guard_and_lifecycle",
        category: "git",
        passed: false,
        durationMs: Date.now() - gitStart,
        error: err.message,
      });
    }

    // 6. Browser: form automation, multi-tab, and unreachable navigation error detection
    const browserStart = Date.now();
    let srv: http.Server | null = null;
    const bSessionId = `bb_browser_${randSuffix}`;
    try {
      srv = http.createServer((req, res) => {
        if (req.url === "/tab2") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<html><head><title>Tab 2</title></head><body><h1>Tab 2 Active</h1></body></html>`);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><head><title>Blackbox Form</title></head><body>
          <input id="userName" value="" />
          <input type="checkbox" id="agreeBox" />
          <div id="status">pending</div>
        </body></html>`);
      });

      await new Promise<void>((resolve) => srv!.listen(0, "127.0.0.1", () => resolve()));
      const port = (srv.address() as any).port;
      const validUrl = `http://127.0.0.1:${port}/`;

      const session = await browserManager.getSession(bSessionId);
      const page = browserManager.getActivePage(session);

      const navRes = await navigateAndVerify(page, validUrl);
      await page.fill("#userName", `User_${randSuffix}`);
      await page.check("#agreeBox");
      const formVal = await page.$eval("#userName", (el: any) => el.value);
      const boxChecked = await page.$eval("#agreeBox", (el: any) => el.checked);

      // Multi-tab
      const newPage = await session.context.newPage();
      session.pages.push(newPage);
      session.activePageIndex = session.pages.length - 1;
      await newPage.goto(`http://127.0.0.1:${port}/tab2`, { waitUntil: "domcontentloaded" });
      const tab2Title = await newPage.title();

      // Unreachable URL check
      const unreachableRes = await navigateAndVerify(newPage, "http://127.0.0.1:65534/");
      const unreachableBlocked = !unreachableRes.success && unreachableRes.errorCode === "BROWSER_NAVIGATION_FAILED";

      await browserManager.closeSession(bSessionId);

      const passed =
        navRes.success &&
        formVal === `User_${randSuffix}` &&
        boxChecked === true &&
        tab2Title === "Tab 2" &&
        unreachableBlocked;

      checks.push({
        name: "browser_form_multitab_and_error_detection",
        category: "browser",
        passed,
        durationMs: Date.now() - browserStart,
        details: { navOk: navRes.success, formVal, boxChecked, tab2Title, unreachableBlocked },
        error: passed ? undefined : "Browser form, multi-tab or navigation error detection failed",
      });
    } catch (err: any) {
      await browserManager.closeSession(bSessionId).catch(() => {});
      checks.push({
        name: "browser_form_multitab_and_error_detection",
        category: "browser",
        passed: false,
        durationMs: Date.now() - browserStart,
        error: err.message,
      });
    } finally {
      if (srv) {
        await new Promise((r) => srv!.close(r)).catch(() => {});
      }
    }

    // 7. Desktop: window listing and regional screenshot
    const deskStart = Date.now();
    try {
      const listRes = executeListWindows();
      const listOk = listRes.success && Array.isArray(listRes.data);

      const capRes = await executeDesktopScreenshot({
        region: { x: 0, y: 0, width: 64, height: 64 },
      });
      const capOk = capRes.toolResponse.success && Boolean(capRes.imagePayload?.data);

      if (capRes.toolResponse.data?.resolved_path && fsSync.existsSync(capRes.toolResponse.data.resolved_path)) {
        await fs.unlink(capRes.toolResponse.data.resolved_path).catch(() => {});
      }

      const passed = listOk && capOk;
      checks.push({
        name: "desktop_list_and_regional_capture",
        category: "desktop",
        passed,
        durationMs: Date.now() - deskStart,
        details: { listOk, capOk, windowCount: listRes.data?.length },
        error: passed ? undefined : "Desktop window listing or screenshot capture failed",
      });
    } catch (err: any) {
      checks.push({
        name: "desktop_list_and_regional_capture",
        category: "desktop",
        passed: false,
        durationMs: Date.now() - deskStart,
        error: err.message,
      });
    }

    // 8. Task Store: lifecycle verification
    const taskStart = Date.now();
    try {
      const subj = `Blackbox Task ${randSuffix}`;
      const createRes = taskStore.createTask(subj, "Test task for blackbox robustness");
      const taskId = createRes.data?.id;

      let taskOk = false;
      if (taskId) {
        const updateRes = taskStore.updateTask(taskId, { status: "completed" });
        const listRes = taskStore.listTasks();
        const found = listRes.data?.find((t: any) => t.id === taskId);
        taskOk = updateRes.success && found?.status === "completed";
      }

      checks.push({
        name: "task_store_lifecycle",
        category: "task_store",
        passed: taskOk,
        durationMs: Date.now() - taskStart,
        details: { taskId, taskOk },
        error: taskOk ? undefined : "Task store create/update/list lifecycle failed",
      });
    } catch (err: any) {
      checks.push({
        name: "task_store_lifecycle",
        category: "task_store",
        passed: false,
        durationMs: Date.now() - taskStart,
        error: err.message,
      });
    }

    // 9. LSP Position Semantics: column-exact resolution (not first-token)
    const lspStart = Date.now();
    try {
      const fnName = `fn_${randSuffix}`;
      const argName = `arg_${randSuffix}`;
      const resName = `res_${randSuffix}`;
      const lspFilePath = path.join(fixtureDir, `lsp_${randSuffix}.ts`);
      const tsCode = `export function ${fnName}(${argName}: number): number { return ${argName} * 2; }\nexport const ${resName} = ${fnName}(42);\n`;
      await fs.writeFile(lspFilePath, tsCode, "utf-8");

      // Line 2: "export const res_xyz = fn_xyz(42);"
      const targetCol = `export const ${resName} = `.length + 2;
      const defRes = await executeLsp({
        workspaceRoot: fixtureDir,
        allowedRoots: [fixtureDir],
        operation: "goToDefinition",
        filePath: lspFilePath,
        line: 2,
        character: targetCol,
      });

      const refRes = await executeLsp({
        workspaceRoot: fixtureDir,
        allowedRoots: [fixtureDir],
        operation: "findReferences",
        filePath: lspFilePath,
        line: 2,
        character: targetCol,
      });

      const lspPassed =
        defRes.success &&
        defRes.data?.result?.symbol === fnName &&
        refRes.success &&
        (refRes.data?.result?.length ?? 0) >= 1;

      checks.push({
        name: "lsp_position_semantics",
        category: "lsp_position",
        passed: lspPassed,
        durationMs: Date.now() - lspStart,
        details: { fnName, resolvedDef: defRes.data?.result?.symbol, refCount: refRes.data?.result?.length },
        error: lspPassed ? undefined : `LSP operation did not resolve target symbol "${fnName}" at column ${targetCol}`,
      });
    } catch (err: any) {
      checks.push({
        name: "lsp_position_semantics",
        category: "lsp_position",
        passed: false,
        durationMs: Date.now() - lspStart,
        error: err.message,
      });
    }

    // 10. Graceful Interrupt Delivery: SIGINT handler observation
    const intStart = Date.now();
    try {
      const marker = `SIGINT_${randSuffix}`;
      const intScriptPath = path.join(fixtureDir, `int_${randSuffix}.cjs`);
      const intScriptContent = `
process.on('SIGINT', () => {
  console.log('${marker}_CAUGHT');
  process.exit(0);
});
process.stdin.on('data', (d) => {
  if (d.includes(3) || d.includes(0x03) || d.toString().includes('SIGINT')) {
    process.emit('SIGINT');
  }
});
console.log('${marker}_READY');
setInterval(() => {}, 1000);
`;
      await fs.writeFile(intScriptPath, intScriptContent, "utf-8");

      const execRes = await processManager.execCommand({
        command: `node "${intScriptPath}"`,
        cwd: fixtureDir,
        runInBackground: true,
      });

      const sessionId = execRes.data?.sessionId;
      let intPassed = false;
      if (sessionId) {
        // Wait for READY
        await new Promise((r) => setTimeout(r, 600));
        const intRes = await processManager.interruptProcess(sessionId);
        await new Promise((r) => setTimeout(r, 200));
        const outRes = await processManager.readProcessOutput(sessionId);
        const fullOutput = (outRes.data?.stdout || "") + (outRes.data?.stderr || "");
        intPassed =
          intRes.success &&
          intRes.data?.graceful === true &&
          intRes.data?.process_exited === true &&
          fullOutput.includes(`${marker}_CAUGHT`);
      }

      checks.push({
        name: "graceful_interrupt_delivery",
        category: "process_interrupt",
        passed: intPassed,
        durationMs: Date.now() - intStart,
        details: { sessionId, intPassed },
        error: intPassed ? undefined : "Graceful SIGINT handler did not execute cleanly",
      });
    } catch (err: any) {
      checks.push({
        name: "graceful_interrupt_delivery",
        category: "process_interrupt",
        passed: false,
        durationMs: Date.now() - intStart,
        error: err.message,
      });
    }

    // 11. Browser Artifact Path Resolution: Relative artifacts stay inside workspace
    const artStart = Date.now();
    const artSessionId = `bb_art_${randSuffix}`;
    try {
      const artSession = await browserManager.getSession(artSessionId);
      const artPage = browserManager.getActivePage(artSession);
      await artPage.setContent(`<html><body><h1>Artifact Test ${randSuffix}</h1></body></html>`);

      // Switch active workspace to fixtureDir
      await workspaceManager.openWorkspace(fixtureDir);

      const relShot = `shot_${randSuffix}.png`;
      const relPdf = `doc_${randSuffix}.pdf`;

      const shotRes = await executeBrowserScreenshot({ session: artSession, outputPath: relShot });
      const pdfRes = await executePdf(artSession, relPdf);

      await browserManager.closeSession(artSessionId);

      const shotPath = path.resolve(fixtureDir, relShot);
      const pdfPath = path.resolve(fixtureDir, relPdf);
      const serverRootShot = path.resolve(serverRoot, relShot);
      const serverRootPdf = path.resolve(serverRoot, relPdf);

      const artPassed =
        shotRes.toolResponse.data?.within_workspace !== false &&
        pdfRes.data?.within_workspace !== false &&
        fsSync.existsSync(shotPath) &&
        fsSync.existsSync(pdfPath) &&
        (fixtureDir === serverRoot || (!fsSync.existsSync(serverRootShot) && !fsSync.existsSync(serverRootPdf)));

      checks.push({
        name: "browser_artifact_path_resolution",
        category: "browser_artifact",
        passed: artPassed,
        durationMs: Date.now() - artStart,
        details: { shotPath, pdfPath, artPassed },
        error: artPassed ? undefined : "Relative browser artifacts did not resolve within workspace root",
      });
    } catch (err: any) {
      await browserManager.closeSession(artSessionId).catch(() => {});
      checks.push({
        name: "browser_artifact_path_resolution",
        category: "browser_artifact",
        passed: false,
        durationMs: Date.now() - artStart,
        error: err.message,
      });
    }

    // 12. Desktop Foreground Focus: Real window focus with verified GetForegroundWindow
    const focusStart = Date.now();
    let bbWinProc: any = null;
    try {
      const isWin = process.platform === "win32";
      if (isWin) {
        const bbWinTitle = `Verity_BB_Focus_${randSuffix}`;
        bbWinProc = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text = "${bbWinTitle}"; $f.Width = 180; $f.Height = 100; [System.Windows.Forms.Application]::Run($f)`,
          ],
          { windowsHide: false }
        );

        await new Promise((r) => setTimeout(r, 1200));

        const listRes = executeListWindows();
        const found = (listRes.data || []).some((w) => w.title?.includes(bbWinTitle));
        const focusRes = executeFocusWindow(bbWinTitle);

        const focusPassed =
          found &&
          focusRes.success === true &&
          focusRes.data?.focused === true &&
          Boolean(focusRes.data?.resolved_hwnd);

        checks.push({
          name: "desktop_foreground_focus",
          category: "desktop_focus",
          passed: focusPassed,
          durationMs: Date.now() - focusStart,
          details: { found, focused: focusRes.data?.focused, method: focusRes.data?.activation_method },
          error: focusPassed ? undefined : "Disposable window focus failed foreground verification",
        });
      } else {
        checks.push({
          name: "desktop_foreground_focus",
          category: "desktop_focus",
          passed: true,
          durationMs: Date.now() - focusStart,
          details: { note: "Skipped on non-Windows" },
        });
      }
    } catch (err: any) {
      checks.push({
        name: "desktop_foreground_focus",
        category: "desktop_focus",
        passed: false,
        durationMs: Date.now() - focusStart,
        error: err.message,
      });
    } finally {
      if (bbWinProc) {
        try { bbWinProc.kill(); } catch {}
      }
    }

    // 13. Workspace Handle Release: Directory deletion after workspace switch without EBUSY
    const wsRelStart = Date.now();
    try {
      // Use an isolated manager here. The seeded battery can run while other MCP
      // conversations are active, so mutating the singleton workspace manager
      // would clobber their current workspace and could leave it pointing at a
      // fixture that this test deletes during cleanup.
      const isolatedWorkspaceManager = new WorkspaceManager();
      const switchWsDir = path.join(fixtureDir, `ws_switch_${randSuffix}`);
      await fs.mkdir(switchWsDir, { recursive: true });
      await fs.writeFile(path.join(switchWsDir, "index.ts"), "export const a = 1;\n", "utf-8");

      // Open workspace
      const openA = await isolatedWorkspaceManager.openWorkspace(switchWsDir);
      let disposableRan = false;
      if (openA.data?.workspace.id) {
        isolatedWorkspaceManager.registerDisposable(openA.data.workspace.id, () => {
          disposableRan = true;
        });
      }

      // Switch to another workspace
      await isolatedWorkspaceManager.openWorkspace(fixtureDir);

      // Verify disposable ran
      assert.ok(disposableRan, "Workspace disposable should run on switch");

      // Now delete old workspace directory
      const delRes = await executeDeleteFile({
        workspaceRoot: fixtureDir,
        allowedRoots: [fixtureDir],
        filePath: switchWsDir,
        recursive: true,
      });

      const delPassed = delRes.success && !fsSync.existsSync(switchWsDir);

      checks.push({
        name: "workspace_handle_release",
        category: "workspace_lifecycle",
        passed: delPassed,
        durationMs: Date.now() - wsRelStart,
        details: { disposableRan, delPassed },
        error: delPassed ? undefined : `Old workspace root remained locked: ${delRes.error_code || "Deletion failed"}`,
      });
    } catch (err: any) {
      checks.push({
        name: "workspace_handle_release",
        category: "workspace_lifecycle",
        passed: false,
        durationMs: Date.now() - wsRelStart,
        error: err.message,
      });
    }
  } finally {
    // Restore caller-visible global state BEFORE deleting the fixture. This is
    // critical because browser/workspace tests intentionally make fixtureDir the
    // active workspace; deleting it first leaves subsequent MCP commands with a
    // dead cwd and misleading spawn ENOENT failures.
    const callerWorkspaceRestored = await restoreCallerWorkspace();
    if (!callerWorkspaceRestored) {
      checks.push({
        name: "blackbox_caller_workspace_restored",
        category: "workspace_lifecycle",
        passed: false,
        durationMs: 0,
        details: { previousWorkspaceRoot: prevWorkspaceRoot || null },
        error: "Black-box cleanup could not restore the caller workspace",
      });
    } else {
      checks.push({
        name: "blackbox_caller_workspace_restored",
        category: "workspace_lifecycle",
        passed: true,
        durationMs: 0,
        details: { previousWorkspaceRoot: prevWorkspaceRoot || null },
      });
    }

    await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    runManager.setActiveRun(prevActiveRun);
  }

  const cleanupVerified = !fsSync.existsSync(fixtureDir);
  const allPassed = checks.every((c) => c.passed) && cleanupVerified;
  const checksPassed = checks.filter((c) => c.passed).length;

  activityStream.emit({
    type: allPassed ? "action_completed" : "failure",
    title: `Blackbox test ${allPassed ? "passed" : "failed"} (${checksPassed}/${checks.length}, seed: ${seed})`,
    tool: "verity_blackbox_test",
  });

  const lines = [
    `=== VerityMCP Seeded Black-Box Robustness Battery ===`,
    `Seed: ${seed}`,
    `Fixture Path: ${fixtureDir} (Cleaned: ${cleanupVerified ? "YES" : "NO"})`,
    `Status: ${allPassed ? "ALL PASS" : "SOME FAIL"} (${checksPassed}/${checks.length})`,
    ...checks.map(
      (c) => `  [${c.passed ? "PASS" : "FAIL"}] ${c.name} (${c.category}, ${c.durationMs}ms)${c.error ? ` - ${c.error}` : ""}`
    ),
  ];

  return {
    success: allPassed,
    error_code: allPassed ? undefined : "COMMAND_FAILED",
    action: "verity_blackbox_test",
    display_title: `Blackbox test (seed: ${seed})`,
    display_status: allPassed ? "verified" : "failed",
    text: lines.join("\n"),
    summary: `Blackbox test (seed: ${seed}): ${checksPassed}/${checks.length} passed, cleanup verified: ${cleanupVerified}`,
    verification: {
      performed: true,
      passed: allPassed,
      method: "orthogonal_blackbox_battery",
      details: { seed, checksPassed, checksTotal: checks.length, cleanupVerified },
    },
    data: {
      allPassed,
      blackbox_seed: seed,
      fixture_path: fixtureDir,
      checksTotal: checks.length,
      checksPassed,
      checks,
      cleanupVerified,
    },
    durationMs: Date.now() - startTime,
  };
}
