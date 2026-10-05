import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess, execSync } from "node:child_process";
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
  outputChunks: OutputChunk[];
  stdoutBytes: number;
  stderrBytes: number;
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
    exit_code?: number | null;
    duration_ms?: number;
    durationMs?: number;
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

    let child: ChildProcess;
    try {
      child = spawn(shellResolved.shell, fullArgs, {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          CI: "true",
          FORCE_COLOR: "0",
        },
      });
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

    session.childProcess = child;
    session.pid = child.pid;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      session.stdoutBytes += chunk.length;
      session.outputChunks.push({
        stream: "stdout",
        text,
        timestamp: Date.now(),
      });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      session.stderrBytes += chunk.length;
      session.outputChunks.push({
        stream: "stderr",
        text,
        timestamp: Date.now(),
      });
    });

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("close", (code, signal) => {
        session.exitCode = code;
        session.status = code === 0 ? "completed" : "failed";
        session.endedAt = Date.now();
        resolve({ code, signal });
      });
      child.on("error", (err) => {
        session.status = "failed";
        session.endedAt = Date.now();
        session.outputChunks.push({
          stream: "stderr",
          text: `\nProcess error: ${err.message}\n`,
          timestamp: Date.now(),
        });
        resolve({ code: -1, signal: null });
      });
    });

    // If explicit background execution requested
    if (runInBackground) {
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
          status: "running",
          exitCode: null,
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
      const success = code === 0;
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
        status: success ? "passed" : "failed",
        method: "process_exit_code_check",
        details: { exitCode: code, wallTimeMs },
      };

      activityStream.emit({
        type: success ? "action_completed" : "failure",
        title: `Process exit ${code} (${wallTimeMs}ms)`,
        tool: "exec_command",
        process_session_id: session.id,
        details: { exitCode: code, wallTimeMs, stderrPresent },
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
    if (!session || !session.childProcess || session.status !== "running") {
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
      const formattedInput = input.endsWith("\n") ? input : `${input}\n`;
      session.childProcess.stdin?.write(formattedInput);
      return {
        success: true,
        action: `write_stdin "${sessionId}"`,
        text: `Sent ${Buffer.byteLength(formattedInput)} bytes to session stdin.`,
        summary: `Sent ${Buffer.byteLength(formattedInput)} bytes to stdin`,
        verification: {
          performed: true,
          passed: true,
          method: "stream_write",
          details: { bytesWritten: Buffer.byteLength(formattedInput) },
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
    sessionId: string
  ): Promise<StandardToolResponse<{ sessionId: string; pid?: number }>> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.childProcess || session.status !== "running") {
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
        data: { sessionId },
      };
    }

    const pid = session.pid;
    try {
      if (session.childProcess.stdin?.writable) {
        try {
          session.childProcess.stdin.write("\x03");
        } catch {}
      }

      session.childProcess.kill("SIGINT");

      setTimeout(() => {
        if (session.status === "running") {
          this.killProcess(sessionId).catch(() => {});
        }
      }, 1500);

      session.status = "interrupted";
      session.endedAt = Date.now();

      return {
        success: true,
        action: `interrupt_process "${sessionId}"`,
        text: `Dispatched interrupt (SIGINT) to process session "${sessionId}" (PID: ${pid}).`,
        summary: `Dispatched SIGINT to ${sessionId} (PID: ${pid})`,
        verification: {
          performed: true,
          passed: true,
          method: "interrupt_signal_dispatched",
          details: { pid },
        },
        data: { sessionId, pid },
      };
    } catch (err: any) {
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
      };
    }
  }

  public async killProcess(
    sessionId: string
  ): Promise<StandardToolResponse<{ sessionId: string; pid?: number }>> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.childProcess || session.status !== "running") {
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
      if (process.platform === "win32" && pid) {
        try {
          execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
        } catch {
          session.childProcess.kill("SIGKILL");
        }
      } else {
        session.childProcess.kill("SIGKILL");
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
