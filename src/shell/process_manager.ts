import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  ProcessSession,
  ProcessStatus,
  ShellType,
  StandardToolResponse,
  ExecutionVerification,
  StateVerification,
} from "../types/index.js";
import { activityStream } from "../observability/activity_stream.js";
import { resolveShellCommand, detectShells } from "./shell_detector.js";
import { formatOutputWithBudget } from "./token_budget.js";
import {
  ensureWindowsPrivateConsoleHost,
  encodeWindowsProcessPayload,
  sendWindowsPrivateConsoleCtrlC,
} from "./windows_console.js";
import {
  ensureGitBashPtyHelper,
  encodeGitBashPtyPayload,
  extractGitBashPtyControl,
} from "./git_bash_pty_helper.js";

export interface ExecVerifyOptions {
  path_exists?: string;
  path_absent?: string;
  stdout_contains?: string;
  exit_code?: number;
}

export interface ExecCommandOptions {
  command: string;
  cwd: string;
  shell?: ShellType | string;
  timeoutMs?: number;
  yieldMs?: number;
  runInBackground?: boolean;
  maxOutputChars?: number;
  verify?: ExecVerifyOptions;
}

export interface OutputChunk {
  stream: "stdout" | "stderr";
  text: string;
  timestamp: number;
}

function sanitizePtyOutput(data: string): string {
  return data
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export interface InternalProcessSession {
  id: string;
  command: string;
  shell: ShellType;
  shellPath: string;
  cwd: string;
  pid?: number;
  status: ProcessStatus;
  startedAt: number;
  endedAt?: number;
  exitCode: number | null;
  childProcess?: ChildProcess;
  completionPromise?: Promise<void>;
  outputChunks: OutputChunk[];
  stdoutBytes: number;
  stderrBytes: number;
  expectedExitCode: number;
  windowsPrivateConsole: boolean;
  terminalTransport: "pipes" | "pty-helper";
  terminationRequested?: "interrupt" | "kill";
}

export interface ProcessOutputResult {
  sessionId: string;
  status: ProcessStatus;
  exitCode: number | null;
  output: string;
  stdout: string;
  stderr: string;
  newCursor: number;
  isComplete: boolean;
  wallTimeMs: number;
}

export class ProcessManager {
  private sessions = new Map<string, InternalProcessSession>();

  public createSession(
    command: string,
    cwd: string,
    shellType?: ShellType | string
  ): InternalProcessSession {
    const resolved = resolveShellCommand(shellType);
    const id = `proc_${randomUUID().slice(0, 8)}`;

    const session: InternalProcessSession = {
      id,
      command,
      shell: resolved.shellType,
      shellPath: resolved.shell,
      cwd,
      status: "running",
      startedAt: Date.now(),
      exitCode: null,
      outputChunks: [],
      stdoutBytes: 0,
      stderrBytes: 0,
      expectedExitCode: 0,
      windowsPrivateConsole: false,
      terminalTransport: "pipes",
    };

    this.sessions.set(id, session);
    return session;
  }

  public getSession(id: string): InternalProcessSession | undefined {
    return this.sessions.get(id);
  }

  public listSessions(): Array<{
    id: string;
    command: string;
    shell: ShellType;
    status: ProcessStatus;
    startedAt: number;
    exitCode: number | null;
  }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      command: s.command,
      shell: s.shell,
      status: s.status,
      startedAt: s.startedAt,
      exitCode: s.exitCode,
    }));
  }

  public async execCommand(options: ExecCommandOptions): Promise<StandardToolResponse<{
    sessionId: string;
    session_id?: string | null;
    shell?: string;
    cwd?: string;
    pid?: number;
    running?: boolean;
    spawn_succeeded?: boolean;
    exit_code?: number | null;
    duration_ms?: number;
    durationMs?: number;
    startup_duration_ms?: number;
    status: ProcessStatus;
    exitCode: number | null;
    isBackground: boolean;
    yielded: boolean;
    nextCursor: number;
    stdout?: string;
    stderr?: string;
  }>> {
    const startTime = Date.now();
    const {
      command,
      cwd,
      shell: requestedShell,
      timeoutMs = 60000,
      yieldMs = 2000,
      runInBackground = false,
      maxOutputChars = 30000,
    } = options;

    let shellResolved;
    try {
      shellResolved = resolveShellCommand(requestedShell);
    } catch (err: any) {
      return {
        success: false,
        action: `exec_command "${command}"`,
        text: `Shell resolution failed: ${err.message}`,
        verification: {
          performed: true,
          passed: false,
          method: "shell_detector",
          error: err.message,
        },
        durationMs: Date.now() - startTime,
      };
    }

    const session = this.createSession(command, cwd, requestedShell);
    session.expectedExitCode = options.verify?.exit_code ?? 0;
    let finalCommand = command;
    if (session.shell === "powershell") {
      finalCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
    }
    const fullArgs = [...shellResolved.argsPrefix, finalCommand];

    activityStream.emit({
      type: "action_started",
      title: `Executing ${session.shell}: ${command.slice(0, 60)}`,
      purpose: "Run shell command and capture process output stream",
      tool: "exec_command",
      process_session_id: session.id,
    });

    let child: ChildProcess | undefined;
    let helperControlStderr = "";
    const processEnv = {
      ...process.env,
      TERM: "xterm-256color",
      CI: "true",
      FORCE_COLOR: "0",
    };

    try {
      const useWindowsGitBashPty = process.platform === "win32" && session.shell === "git-bash";
      if (useWindowsGitBashPty) {
        const helper = ensureGitBashPtyHelper();
        child = spawn(process.execPath, [
          helper.helperPath,
          encodeGitBashPtyPayload(shellResolved.shell, cwd, fullArgs),
        ], {
          cwd,
          windowsHide: true,
          env: {
            ...processEnv,
            DEVSPACE_NODE_PTY_ENTRY: helper.nodePtyEntry,
          },
        });
        session.terminalTransport = "pty-helper";
      } else {
        let spawnExecutable = shellResolved.shell;
        let spawnArgs = fullArgs;
        if (process.platform === "win32") {
          const hostPath = ensureWindowsPrivateConsoleHost();
          spawnExecutable = hostPath;
          spawnArgs = [encodeWindowsProcessPayload(shellResolved.shell, cwd, fullArgs)];
          session.windowsPrivateConsole = true;
        }

        child = spawn(spawnExecutable, spawnArgs, {
          cwd,
          windowsHide: true,
          env: processEnv,
        });
      }
      session.childProcess = child;
      session.pid = child.pid;
    } catch (err: any) {
      session.status = "failed";
      session.endedAt = Date.now();
      return {
        success: false,
        action: `exec_command "${command}"`,
        text: `Failed to spawn process with ${shellResolved.shell}: ${err.message}`,
        verification: {
          performed: true,
          passed: false,
          method: "process_spawn",
          error: err.message,
        },
        durationMs: Date.now() - startTime,
      };
    }

    type ExitResult = { code: number | null; signal: NodeJS.Signals | number | null };
    let resolveExit!: (value: ExitResult) => void;
    let exitSettled = false;
    const exitPromise = new Promise<ExitResult>((resolve) => {
      resolveExit = resolve;
    });
    session.completionPromise = exitPromise.then(() => undefined);

    type StartupActivity = { stream: "stdout" | "stderr"; text: string };
    let resolveStartupActivity!: (activity: StartupActivity) => void;
    let startupActivitySettled = false;
    const startupActivityPromise = new Promise<StartupActivity>((resolve) => {
      resolveStartupActivity = resolve;
    });
    const noteStartupActivity = (activity: StartupActivity) => {
      if (startupActivitySettled) return;
      startupActivitySettled = true;
      resolveStartupActivity(activity);
    };

    const finalizeExit = (code: number | null, signal: NodeJS.Signals | number | null) => {
      if (exitSettled) return;
      exitSettled = true;
      session.exitCode = code;
      session.status = session.terminationRequested
        ? "interrupted"
        : code === session.expectedExitCode
        ? "completed"
        : "failed";
      session.endedAt = Date.now();
      activityStream.emit({
        type: session.status === "failed" ? "failure" : "action_completed",
        title: `Process exited (${session.id})`,
        tool: "process_completed",
        target: session.id,
        process_session_id: session.id,
        details: {
          status: session.status,
          exit_code: session.exitCode,
          exitCode: session.exitCode,
          expectedExitCode: session.expectedExitCode,
          transport: session.terminalTransport,
          terminationRequested: session.terminationRequested,
        },
      });
      resolveExit({ code, signal });

      if (child) {
        setImmediate(() => {
          try { child?.stdin?.destroy(); } catch {}
          try { child?.stdout?.destroy(); } catch {}
          try { child?.stderr?.destroy(); } catch {}
          if (session.childProcess === child) session.childProcess = undefined;
        });
      }
    };

    if (child) {
      child.stdout?.on("data", (chunk: Buffer) => {
        const raw = chunk.toString("utf-8");
        const text = session.terminalTransport === "pty-helper"
          ? sanitizePtyOutput(raw)
          : raw;
        if (!text) return;
        noteStartupActivity({ stream: "stdout", text });
        session.stdoutBytes += Buffer.byteLength(text, "utf8");
        session.outputChunks.push({
          stream: "stdout",
          text,
          timestamp: Date.now(),
        });
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        if (session.terminalTransport === "pty-helper") {
          helperControlStderr += text;
        } else {
          noteStartupActivity({ stream: "stderr", text });
          session.stderrBytes += chunk.length;
          session.outputChunks.push({
            stream: "stderr",
            text,
            timestamp: Date.now(),
          });
        }
      });

      child.on("close", (code, signal) => {
        let finalCode = code;
        if (session.terminalTransport === "pty-helper") {
          const control = extractGitBashPtyControl(helperControlStderr);
          if (control.stderr) {
            session.stderrBytes += Buffer.byteLength(control.stderr, "utf8");
            session.outputChunks.push({
              stream: "stderr",
              text: control.stderr,
              timestamp: Date.now(),
            });
          }
          if (control.exitCode !== undefined) {
            finalCode = control.exitCode;
          }
        }
        finalizeExit(finalCode, signal);
      });
      child.on("error", (err) => {
        session.outputChunks.push({
          stream: "stderr",
          text: `\nProcess error: ${err.message}\n`,
          timestamp: Date.now(),
        });
        finalizeExit(-1, null);
      });
    }

    const startupExitPromise = new Promise<ExitResult>((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        resolve({
          code: child?.exitCode ?? session.exitCode,
          signal: (child?.signalCode as NodeJS.Signals | null | undefined) ?? null,
        });
        return;
      }
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    // If explicit background execution requested, observe startup rather than relying on a
    // single short sleep. Chatty commands can be accepted as soon as they actually emit
    // output; silent PowerShell commands get a longer bounded window because powershell.exe
    // startup time can vary materially under load.
    if (runInBackground) {
      const backgroundGraceMs = session.terminalTransport === "pty-helper"
        ? 2000
        : session.shell === "powershell"
        ? 2500
        : 1000;
      let graceTimer: NodeJS.Timeout | undefined;
      const gracePromise = new Promise<"grace">((res) => {
        graceTimer = setTimeout(() => res("grace"), backgroundGraceMs);
      });

      let outcome = await Promise.race([
        startupExitPromise.then((exit) => ({ kind: "exit" as const, exit })),
        startupActivityPromise.then((activity) => ({ kind: "activity" as const, activity })),
        gracePromise.then(() => ({ kind: "grace" as const })),
      ]);
      if (graceTimer) clearTimeout(graceTimer);

      if (outcome.kind === "activity") {
        const fatalPowerShellStartup =
          session.shell === "powershell" &&
          outcome.activity.stream === "stderr" &&
          /CommandNotFoundException|is not recognized as the name of a cmdlet|ParserError|At line:\d+ char:\d+/i.test(
            outcome.activity.text
          );
        const fatalGitBashStartup =
          session.terminalTransport === "pty-helper" &&
          /(?:^|\s)(?:bash:\s*)?.*command not found|syntax error near unexpected token|unexpected EOF while looking for matching/i.test(
            outcome.activity.text
          );
        const fatalCmdStartup =
          session.shell === "cmd" &&
          /is not recognized as an internal or external command|The syntax of the command is incorrect/i.test(
            outcome.activity.text
          );
        const fatalShellStartup =
          fatalPowerShellStartup || fatalGitBashStartup || fatalCmdStartup;

        // Activity means the shell has started executing the requested command. Give the
        // process a short settlement interval so an immediate post-output exit is still
        // classified synchronously. Known PowerShell startup errors get a longer drain
        // interval because they are definitively fatal even if the wrapper has not closed yet.
        const settleMs = fatalShellStartup
          ? 1500
          : session.terminalTransport === "pty-helper"
          ? 600
          : 300;
        const settled = await Promise.race([
          startupExitPromise.then((exit) => ({ kind: "exit" as const, exit })),
          new Promise<{ kind: "running" }>((resolve) =>
            setTimeout(() => resolve({ kind: "running" }), settleMs)
          ),
        ]);

        if (settled.kind === "exit") {
          outcome = settled;
        } else if (fatalShellStartup) {
          // Shell-level CommandNotFound/ParserError/syntax failures cannot become a
          // healthy long-running command.
          // Wait for the wrapper to close if it is already in teardown, then return the
          // observed non-zero state. Do not report a healthy background session.
          await Promise.race([
            exitPromise,
            new Promise((resolve) => setTimeout(resolve, 500)),
          ]);
          const exitCode = session.exitCode ?? -1;
          const stdout = session.outputChunks.filter((c) => c.stream === "stdout").map((c) => c.text).join("");
          const stderr = session.outputChunks.filter((c) => c.stream === "stderr").map((c) => c.text).join("");
          return {
            success: false,
            error_code: "PROCESS_EXITED_IMMEDIATELY",
            action: `exec_command (background) "${command}"`,
            text: `Background command failed during PowerShell startup (PID: ${session.pid}, Exit Code: ${exitCode}).\n${stderr || stdout || outcome.activity.text}`,
            summary: `Background process failed during startup with code ${exitCode}`,
            verification: {
              performed: true,
              passed: false,
              method: "background_process_startup_activity",
              error: `${session.shell} reported a fatal command startup error`,
              details: {
                sessionId: session.id,
                pid: session.pid,
                exitCode,
                expectedExitCode: session.expectedExitCode,
                stderr,
                stdout,
              },
            },
            data: {
              sessionId: session.id,
              session_id: session.id,
              spawn_succeeded: true,
              running: session.status === "running",
              status: session.status,
              exitCode,
              exit_code: exitCode,
              isBackground: true,
              yielded: false,
              nextCursor: session.outputChunks.length,
              stdout,
              stderr,
              startup_duration_ms: Date.now() - startTime,
            },
            durationMs: Date.now() - startTime,
          };
        } else {
          // Non-fatal output proves the command reached execution and remains alive.
          return {
            success: true,
            action: `exec_command (background) "${command}"`,
            text: `Command launched in background (Session ID: ${session.id}, PID: ${session.pid}, Shell: ${session.shell}). Use read_process_output to monitor stdout/stderr.`,
            verification: {
              performed: true,
              passed: true,
              method: "process_startup_activity_verification",
              details: {
                sessionId: session.id,
                pid: session.pid,
                shell: session.shell,
                firstStream: outcome.activity.stream,
              },
            },
            data: {
              sessionId: session.id,
              session_id: session.id,
              spawn_succeeded: true,
              running: true,
              status: session.status,
              exitCode: null,
              exit_code: null,
              isBackground: true,
              yielded: false,
              nextCursor: session.outputChunks.length,
            },
            durationMs: Date.now() - startTime,
          };
        }
      }

      if (outcome.kind === "exit") {
        // Drain the close event/output briefly so the immediate-exit response contains final stderr/stdout.
        await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 150))]);
        const exitCode = session.exitCode !== null ? session.exitCode : (outcome.exit.code ?? -1);
        const stdout = session.outputChunks.filter((c) => c.stream === "stdout").map((c) => c.text).join("");
        const stderr = session.outputChunks.filter((c) => c.stream === "stderr").map((c) => c.text).join("");
        const expected = exitCode === session.expectedExitCode;

        activityStream.emit({
          type: expected ? "action_completed" : "failure",
          title: expected
            ? `Background process completed during startup (${session.id})`
            : `Background process exited immediately (${session.id})`,
          tool: "exec_command",
          process_session_id: session.id,
          target: session.id,
          details: { status: session.status, exit_code: exitCode, exitCode, expectedExitCode: session.expectedExitCode },
        });

        return {
          success: expected,
          error_code: expected ? undefined : "PROCESS_EXITED_IMMEDIATELY",
          action: `exec_command (background) "${command}"`,
          text: expected
            ? `Background command completed during startup with expected exit code ${exitCode}.\n${stdout || stderr || "(no output)"}`
            : `Background command exited immediately during startup grace window (PID: ${session.pid}, Exit Code: ${exitCode}).\n${stderr || stdout || "(no output)"}`,
          summary: expected
            ? `Background process completed with expected code ${exitCode}`
            : `Background process exited immediately with code ${exitCode}`,
          verification: {
            performed: true,
            passed: expected,
            method: "background_process_startup_grace",
            error: expected ? undefined : `Process exited immediately with code ${exitCode}`,
            details: { sessionId: session.id, pid: session.pid, exitCode, expectedExitCode: session.expectedExitCode, stderr, stdout },
          },
          data: {
            sessionId: session.id,
            session_id: session.id,
            spawn_succeeded: true,
            running: false,
            status: session.status,
            exitCode,
            exit_code: exitCode,
            isBackground: true,
            yielded: false,
            nextCursor: session.outputChunks.length,
            stdout,
            stderr,
            startup_duration_ms: Date.now() - startTime,
          },
          durationMs: Date.now() - startTime,
        };
      }

      // Process survived the startup grace window
      return {
        success: true,
        action: `exec_command (background) "${command}"`,
        text: `Command launched in background (Session ID: ${session.id}, PID: ${session.pid}, Shell: ${session.shell}). Use read_process_output to monitor stdout/stderr.`,
        verification: {
          performed: true,
          passed: true,
          method: "process_spawn_pid_verification",
          details: { sessionId: session.id, pid: session.pid, shell: session.shell },
        },
        data: {
          sessionId: session.id,
          session_id: session.id,
          spawn_succeeded: true,
          running: true,
          status: "running",
          exitCode: null,
          exit_code: null,
          isBackground: true,
          yielded: false,
          nextCursor: session.outputChunks.length,
        },
        durationMs: Date.now() - startTime,
      };
    }

    // Synchronous execution with yield window
    const effectiveYield = Math.min(yieldMs, timeoutMs);
    let timeoutTimer: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<"yield">((res) => {
      timeoutTimer = setTimeout(() => res("yield"), effectiveYield);
    });

    const outcome = await Promise.race([
      exitPromise.then((res) => ({ type: "exit" as const, res })),
      timeoutPromise.then(() => ({ type: "yield" as const })),
    ]);

    if (timeoutTimer) clearTimeout(timeoutTimer);

    const wallTimeMs = Date.now() - startTime;

    if (outcome.type === "exit") {
      const code = session.exitCode;
      const exitMatched = code === session.expectedExitCode;
      const stdoutRaw = session.outputChunks
        .filter((c) => c.stream === "stdout")
        .map((c) => c.text)
        .join("");
      const stderrRaw = session.outputChunks
        .filter((c) => c.stream === "stderr")
        .map((c) => c.text)
        .join("");

      const formattedStdout = formatOutputWithBudget(stdoutRaw, maxOutputChars);
      const formattedStderr = formatOutputWithBudget(stderrRaw, maxOutputChars);

      const stderrPresent = stderrRaw.trim().length > 0;
      const warnings: string[] = [];
      if (code === 0 && stderrPresent) {
        warnings.push("Command emitted stderr despite exit code 0.");
        activityStream.emit({
          type: "warning",
          title: "Command emitted stderr despite exit code 0",
          tool: "exec_command",
          process_session_id: session.id,
          details: { stderrSnippet: stderrRaw.trim().slice(0, 200) },
        });
      }

      // State verification: defaults to not_observable unless explicit postconditions are tested
      let stateVerif: StateVerification = {
        status: "not_observable",
      };

      if (options.verify) {
        let verifyPassed = true;
        const details: Record<string, unknown> = {};

        if (options.verify.exit_code !== undefined) {
          const match = code === options.verify.exit_code;
          details.exit_code = { expected: options.verify.exit_code, actual: code, passed: match };
          if (!match) verifyPassed = false;
        }

        if (options.verify.stdout_contains) {
          const match = stdoutRaw.includes(options.verify.stdout_contains);
          details.stdout_contains = { expected: options.verify.stdout_contains, passed: match };
          if (!match) verifyPassed = false;
        }

        if (options.verify.path_exists) {
          const target = path.isAbsolute(options.verify.path_exists)
            ? options.verify.path_exists
            : path.resolve(cwd, options.verify.path_exists);
          let exists = false;
          try {
            fs.statSync(target);
            exists = true;
          } catch {}
          details.path_exists = { path: target, passed: exists };
          if (!exists) verifyPassed = false;
        }

        if (options.verify.path_absent) {
          const target = path.isAbsolute(options.verify.path_absent)
            ? options.verify.path_absent
            : path.resolve(cwd, options.verify.path_absent);
          let absent = false;
          try {
            fs.statSync(target);
          } catch (e: any) {
            if (e.code === "ENOENT") absent = true;
          }
          details.path_absent = { path: target, passed: absent };
          if (!absent) verifyPassed = false;
        }

        stateVerif = {
          status: verifyPassed ? "passed" : "failed",
          method: "postcondition_check",
          details,
          error: verifyPassed ? undefined : "One or more postconditions failed",
        };
      }

      const execVerif: ExecutionVerification = {
        status: exitMatched ? "passed" : "failed",
        method: "process_exit_code_check",
        details: { exitCode: code, expectedExitCode: session.expectedExitCode, wallTimeMs },
      };
      const success = exitMatched && stateVerif.status !== "failed";

      activityStream.emit({
        type: success ? "action_completed" : "failure",
        title: `Process exit ${code} (${wallTimeMs}ms)`,
        tool: "exec_command",
        process_session_id: session.id,
        details: {
          exitCode: code,
          expectedExitCode: session.expectedExitCode,
          wallTimeMs,
          stderrPresent,
          status: success ? "completed" : "failed",
          postconditions: stateVerif.status,
        },
      });

      return {
        success,
        error_code: success ? undefined : "COMMAND_FAILED",
        action: `exec_command "${command}"`,
        display_title: `Running command: ${command.slice(0, 50)}`,
        display_status: warnings.length > 0 && success ? "warning" : (success ? (options.verify && stateVerif.status === "passed" ? "verified" : "completed") : "failed"),
        text: `Process finished with exit code ${code} in ${wallTimeMs}ms`,
        stdout: formattedStdout.text,
        stderr: formattedStderr.text,
        exitCode: code,
        stderr_present: stderrPresent,
        warnings: warnings.length > 0 ? warnings : undefined,
        execution_verification: execVerif,
        state_verification: stateVerif,
        verification: {
          performed: true,
          passed: success && (options.verify ? stateVerif.status === "passed" : true),
          method: "process_exit_code_check",
          details: { exitCode: code, wallTimeMs },
          execution: execVerif,
          state: stateVerif,
        },
        data: {
          sessionId: session.id,
          session_id: session.id,
          shell: session.shell,
          cwd: session.cwd,
          pid: session.pid,
          running: false,
          exit_code: code,
          exitCode: code,
          duration_ms: wallTimeMs,
          durationMs: wallTimeMs,
          status: session.status,
          isBackground: false,
          yielded: false,
          nextCursor: session.outputChunks.length,
          stdout: formattedStdout.text,
          stderr: formattedStderr.text,
        },
        durationMs: wallTimeMs,
      };
    }

    // Yielded: command still running after yieldMs
    const stdoutSoFar = session.outputChunks
      .filter((c) => c.stream === "stdout")
      .map((c) => c.text)
      .join("");
    const stderrSoFar = session.outputChunks
      .filter((c) => c.stream === "stderr")
      .map((c) => c.text)
      .join("");

    return {
      success: true,
      action: `exec_command (yielded) "${command}"`,
      text: `Command is still running after ${effectiveYield}ms (Session ID: ${session.id}, PID: ${session.pid}). Use read_process_output to stream more output or write_process_input to send input.`,
      stdout: stdoutSoFar,
      stderr: stderrSoFar,
      exitCode: null,
      verification: {
        performed: true,
        passed: true,
        method: "process_yield_alive_verification",
        details: { sessionId: session.id, pid: session.pid, running: true },
      },
      data: {
        sessionId: session.id,
        status: "running",
        exitCode: null,
        isBackground: false,
        yielded: true,
        nextCursor: session.outputChunks.length,
      },
      durationMs: wallTimeMs,
    };
  }

  public readProcessOutput(
    sessionId: string,
    cursor = 0,
    maxChars = 30000
  ): StandardToolResponse<ProcessOutputResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        success: false,
        error_code: "PROCESS_NOT_FOUND",
        action: `read_process_output "${sessionId}"`,
        text: `Session "${sessionId}" not found.`,
        summary: `Process session not found`,
        verification: {
          performed: true,
          passed: false,
          method: "session_lookup",
          error: "Session ID does not exist",
        },
      };
    }

    const newChunks = session.outputChunks.slice(cursor);
    const newCursor = session.outputChunks.length;

    const stdout = newChunks
      .filter((c) => c.stream === "stdout")
      .map((c) => c.text)
      .join("");
    const stderr = newChunks
      .filter((c) => c.stream === "stderr")
      .map((c) => c.text)
      .join("");

    const combined = newChunks.map((c) => c.text).join("");
    const formatted = formatOutputWithBudget(combined, maxChars);

    const isComplete = session.status !== "running";
    const wallTimeMs = (session.endedAt ?? Date.now()) - session.startedAt;

    const lines: string[] = [
      `Session ID: ${session.id} | Status: ${session.status} | Exit Code: ${session.exitCode ?? "N/A"}`,
      `Chunks read: ${newChunks.length} (cursor: ${cursor} -> ${newCursor})`,
    ];
    if (formatted.text.trim()) {
      lines.push(`\n${formatted.text}`);
    } else {
      lines.push(`\n[No new output since cursor ${cursor}]`);
    }

    return {
      success: true,
      action: `read_process_output "${sessionId}"`,
      text: lines.join("\n"),
      summary: `Read ${newChunks.length} chunks from ${session.id} (status: ${session.status})`,
      stdout,
      stderr,
      exitCode: session.exitCode,
      verification: {
        performed: true,
        passed: true,
        method: "session_buffer_read",
        details: {
          sessionId,
          status: session.status,
          totalChunks: session.outputChunks.length,
          newChunksCount: newChunks.length,
        },
      },
      data: {
        sessionId,
        status: session.status,
        exitCode: session.exitCode,
        output: formatted.text,
        stdout,
        stderr,
        newCursor,
        isComplete,
        wallTimeMs,
      },
    };
  }

  public async writeStdin(
    sessionId: string,
    input: string
  ): Promise<StandardToolResponse<{ sessionId: string; bytesWritten: number }>> {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      !session.childProcess ||
      session.status !== "running"
    ) {
      return {
        success: false,
        error_code: "PROCESS_NOT_FOUND",
        action: `write_stdin "${sessionId}"`,
        text: `Cannot write to stdin: Session "${sessionId}" is not running.`,
        summary: `Cannot write to stdin: session not running`,
        verification: {
          performed: true,
          passed: false,
          method: "session_stdin_active_check",
          error: "Process not active",
        },
      };
    }

    try {
      const isPtyHelper = session.terminalTransport === "pty-helper";
      const formattedInput = isPtyHelper
        ? (/[\r\n]$/.test(input) ? input : `${input}\r`)
            .replace(/\r\n/g, "\r")
            .replace(/\n/g, "\r")
        : (input.endsWith("\n") ? input : `${input}\n`);
      session.childProcess?.stdin?.write(formattedInput);
      const deliveryMethod = isPtyHelper
        ? "pty_helper_write"
        : "stream_write";
      return {
        success: true,
        action: `write_stdin "${sessionId}"`,
        text: `Sent ${Buffer.byteLength(formattedInput)} bytes to session stdin.`,
        summary: `Sent ${Buffer.byteLength(formattedInput)} bytes to stdin`,
        verification: {
          performed: true,
          passed: true,
          method: deliveryMethod,
          details: {
            bytesWritten: Buffer.byteLength(formattedInput),
            transport: session.terminalTransport,
          },
        },
        data: {
          sessionId,
          bytesWritten: Buffer.byteLength(formattedInput),
        },
      };
    } catch (err: any) {
      return {
        success: false,
        error_code: "COMMAND_FAILED",
        action: `write_stdin "${sessionId}"`,
        text: `Failed writing to process stdin: ${err.message}`,
        summary: `Failed writing to stdin: ${err.message}`,
        verification: {
          performed: true,
          passed: false,
          method: "stream_write",
          error: err.message,
        },
      };
    }
  }

  public async interruptProcess(
    sessionId: string,
    timeoutMs = 2500
  ): Promise<StandardToolResponse<{
    sessionId: string;
    pid?: number;
    signal_requested?: string;
    delivery_method?: string;
    dispatch_succeeded?: boolean;
    process_exited?: boolean;
    exit_code?: number | null;
    exitCode?: number | null;
    graceful?: boolean;
  }>> {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      !session.childProcess ||
      session.status !== "running"
    ) {
      return {
        success: true,
        action: `interrupt_process "${sessionId}"`,
        text: `Session "${sessionId}" is already stopped (status: ${session?.status ?? "unknown"}).`,
        summary: `Session already stopped`,
        verification: {
          performed: true,
          passed: true,
          method: "session_status_check",
        },
        data: {
          sessionId,
          pid: session?.pid,
          process_exited: true,
          exit_code: session?.exitCode ?? 0,
        },
      };
    }

    const pid = session.pid;
    const isWin = process.platform === "win32";
    const child = session.childProcess;
    let deliveryMethod = "sigint_signal";

    try {
      session.terminationRequested = "interrupt";
      if (session.terminalTransport === "pty-helper") {
        if (!child?.stdin?.writable) {
          throw new Error("PTY helper stdin is unavailable for Ctrl-C delivery.");
        }
        child.stdin.write("\x03");
        deliveryMethod = isWin ? "windows_pty_ctrl_c" : "pty_ctrl_c";
      } else if (isWin) {
        if (!pid || !session.windowsPrivateConsole) {
          throw new Error("Windows process does not own a private console for graceful Ctrl-C delivery.");
        }
        const dispatch = sendWindowsPrivateConsoleCtrlC(pid);
        if (!dispatch.success) {
          throw new Error(dispatch.error || "GenerateConsoleCtrlEvent failed");
        }
        deliveryMethod = "windows_private_console_ctrl_c";
      } else {
        if (!child) throw new Error("Process transport is unavailable for SIGINT dispatch.");
        const dispatched = child.kill("SIGINT");
        if (!dispatched) throw new Error("SIGINT dispatch returned false");
      }

      const completion = session.completionPromise;
      if (!completion) {
        throw new Error("Process completion tracker is unavailable.");
      }
      const exited = await Promise.race([
        completion.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);

      if (exited) {
        session.status = "interrupted";
        session.endedAt = Date.now();

        activityStream.emit({
          type: "action_completed",
          title: `Process interrupted gracefully (${sessionId})`,
          tool: "interrupt_process",
          process_session_id: sessionId,
          target: sessionId,
          details: { status: "interrupted", exit_code: session.exitCode, exitCode: session.exitCode },
        });

        return {
          success: true,
          action: `interrupt_process "${sessionId}"`,
          text: `Dispatched interrupt (SIGINT) to process session "${sessionId}" (PID: ${pid}). Process exited gracefully with code ${session.exitCode}.`,
          summary: `Interrupted ${sessionId} gracefully (PID: ${pid})`,
          verification: {
            performed: true,
            passed: true,
            method: "graceful_interrupt",
            details: { pid, exitCode: session.exitCode, deliveryMethod, graceful: true },
          },
          data: {
            sessionId,
            pid,
            signal_requested: "SIGINT",
            delivery_method: deliveryMethod,
            dispatch_succeeded: true,
            process_exited: true,
            exit_code: session.exitCode,
            exitCode: session.exitCode,
            graceful: true,
          },
        };
      }

      // Process did not exit before timeout
      return {
        success: false,
        error_code: "INTERRUPT_TIMEOUT",
        action: `interrupt_process "${sessionId}"`,
        text: `Process session "${sessionId}" (PID: ${pid}) did not exit within ${timeoutMs}ms following interrupt signal. Call kill_process for forced termination.`,
        summary: `Interrupt timed out for ${sessionId}`,
        verification: {
          performed: true,
          passed: false,
          method: "graceful_interrupt",
          error: "Process did not exit before timeout",
          details: { pid, dispatch_succeeded: true, process_exited: false },
        },
        data: {
          sessionId,
          pid,
          signal_requested: "SIGINT",
          delivery_method: deliveryMethod,
          dispatch_succeeded: true,
          process_exited: false,
        },
      };
    } catch (err: any) {
      if (session.status === "running" && session.terminationRequested === "interrupt") {
        session.terminationRequested = undefined;
      }
      return {
        success: false,
        error_code: "COMMAND_FAILED",
        action: `interrupt_process "${sessionId}"`,
        text: `Failed to interrupt process: ${err.message}`,
        summary: `Interrupt failed: ${err.message}`,
        verification: {
          performed: true,
          passed: false,
          method: "interrupt_signal",
          error: err.message,
        },
        data: {
          sessionId,
          pid,
          dispatch_succeeded: false,
          process_exited: false,
        },
      };
    }
  }

  public async killProcess(
    sessionId: string
  ): Promise<StandardToolResponse<{ sessionId: string; pid?: number }>> {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      !session.childProcess ||
      session.status !== "running"
    ) {
      return {
        success: true,
        action: `kill_process "${sessionId}"`,
        text: `Session "${sessionId}" is already terminated (status: ${session?.status ?? "unknown"}).`,
        summary: `Session already terminated`,
        verification: {
          performed: true,
          passed: true,
          method: "session_status_check",
        },
        data: { sessionId },
      };
    }

    const pid = session.pid;
    try {
      session.terminationRequested = "kill";
      if (process.platform === "win32" && pid) {
        try {
          execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        } catch {
          session.childProcess?.kill("SIGKILL");
        }
      } else {
        session.childProcess?.kill("SIGKILL");
      }

      if (session.completionPromise) {
        await Promise.race([
          session.completionPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 1000)),
        ]);
      }
      session.status = "interrupted";
      session.endedAt = Date.now();

      return {
        success: true,
        action: `kill_process "${sessionId}"`,
        text: `Forcefully terminated process tree for session "${sessionId}" (PID: ${pid}).`,
        summary: `Terminated process tree for ${sessionId} (PID: ${pid})`,
        verification: {
          performed: true,
          passed: true,
          method: "tree_kill_dispatched",
          details: { pid },
        },
        data: { sessionId, pid },
      };
    } catch (err: any) {
      if (session.status === "running" && session.terminationRequested === "kill") {
        session.terminationRequested = undefined;
      }
      return {
        success: false,
        error_code: "COMMAND_FAILED",
        action: `kill_process "${sessionId}"`,
        text: `Failed to kill process: ${err.message}`,
        summary: `Kill failed: ${err.message}`,
        verification: {
          performed: true,
          passed: false,
          method: "tree_kill",
          error: err.message,
        },
      };
    }
  }
}

export const processManager = new ProcessManager();
