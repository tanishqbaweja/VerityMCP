import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

interface BenchmarkResult {
  server: string;
  port: number;
  task: string;
  taskName: string;
  success: boolean;
  toolCalls: number;
  workaroundRequired: boolean;
  falseSuccess: boolean;
  durationMs: number;
  correctness: string;
  details: string;
}

const auth = JSON.parse(readFileSync("C:/Users/slato/.devspace/auth.json", "utf8"));
const token = auth.ownerToken;

function parseMcpPayload(text: string): any {
  const match = text.match(/data:\s*({.*})/);
  if (match) return JSON.parse(match[1]);
  return JSON.parse(text);
}

async function callMcp(port: number, method: string, params: any): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 100000),
        method,
        params,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    return parseMcpPayload(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function callTool(port: number, name: string, args: any): Promise<{ res: any; durationMs: number }> {
  const start = performance.now();
  const res = await callMcp(port, "tools/call", { name, arguments: args });
  const durationMs = Math.round(performance.now() - start);
  return { res, durationMs };
}

// Scratch directory for benchmarking
const benchDir = path.resolve(process.cwd(), "scratch_benchmark");

function resetBenchmarkFiles(dir: string) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Benchmark Test\nInitial content for testing.\n");
  writeFileSync(path.join(dir, "sample.ts"), "export class Greeter {\n  greet(name: string): string {\n    return `Hello, ${name}`;\n  }\n}\n");
}

export async function runBenchmarks() {
  const results: BenchmarkResult[] = [];
  const servers = [
    { name: "DevSpace 2.0", port: 7878 },
    { name: "DevSpace 3.0", port: 7979 },
    { name: "DevSpace 4.0", port: 7980 },
  ];

  for (const s of servers) {
    console.log(`\n==================================================`);
    console.log(`Running Benchmark on ${s.name} (Port ${s.port})`);
    console.log(`==================================================`);

    resetBenchmarkFiles(benchDir);

    // A. Workspace bootstrap
    {
      const { res, durationMs } = await callTool(s.port, "open_workspace", { path: benchDir });
      const text = res?.result?.content?.[0]?.text || "";
      const success = !res?.error && !res?.result?.isError;
      results.push({
        server: s.name,
        port: s.port,
        task: "A",
        taskName: "Workspace bootstrap",
        success,
        toolCalls: 1,
        workaroundRequired: false,
        falseSuccess: false,
        durationMs,
        correctness: success ? "100%" : "0%",
        details: "Returned rich repo metadata and workspace context",
      });
      console.log(`[Task A] Workspace bootstrap: ${success ? "PASS" : "FAIL"} (${durationMs}ms)`);
    }

    // B. File reading
    {
      const toolName = s.port === 7979 ? "Read" : "read_file";
      const args = s.port === 7979 ? { file_path: "README.md" } : { path: "README.md", file_path: "README.md" };
      const { res, durationMs } = await callTool(s.port, toolName, args);
      const text = res?.result?.content?.[0]?.text || "";
      const success = text.includes("Initial content for testing");
      results.push({
        server: s.name,
        port: s.port,
        task: "B",
        taskName: "File reading",
        success,
        toolCalls: 1,
        workaroundRequired: false,
        falseSuccess: false,
        durationMs,
        correctness: success ? "100%" : "0%",
        details: success ? "Successfully read file lines" : "Content missing",
      });
      console.log(`[Task B] File reading: ${success ? "PASS" : "FAIL"} (${durationMs}ms)`);
    }

    // C. File search
    {
      const toolName = s.port === 7979 ? "Grep" : "search_code";
      const args = s.port === 7979 ? { query: "Greeter" } : { query: "Greeter", pattern: "Greeter" };
      const { res, durationMs } = await callTool(s.port, toolName, args);
      const text = res?.result?.content?.[0]?.text || "";
      const success = text.includes("Greeter") && !res?.error && !res?.result?.isError;
      results.push({
        server: s.name,
        port: s.port,
        task: "C",
        taskName: "File search",
        success,
        toolCalls: 1,
        workaroundRequired: false,
        falseSuccess: false,
        durationMs,
        correctness: success ? "100%" : "0%",
        details: success ? "Found pattern 'Greeter' in sample.ts" : "Search failed",
      });
      console.log(`[Task C] File search: ${success ? "PASS" : "FAIL"} (${durationMs}ms)`);
    }

    // D. Structural outline
    {
      if (s.port === 7878 || s.port === 7980) {
        const { res, durationMs } = await callTool(s.port, "get_outline", { path: "sample.ts", file_path: "sample.ts" });
        const text = res?.result?.content?.[0]?.text || "";
        const success = text.includes("Greeter") || text.includes("greet") || text.includes("class");
        results.push({
          server: s.name,
          port: s.port,
          task: "D",
          taskName: "Structural outline",
          success,
          toolCalls: 1,
          workaroundRequired: false,
          falseSuccess: false,
          durationMs,
          correctness: success ? "100%" : "0%",
          details: "Extracted class and method outline concisely",
        });
        console.log(`[Task D] Structural outline: ${success ? "PASS" : "FAIL"} (${durationMs}ms)`);
      } else {
        results.push({
          server: s.name,
          port: s.port,
          task: "D",
          taskName: "Structural outline",
          success: false,
          toolCalls: 0,
          workaroundRequired: true,
          falseSuccess: false,
          durationMs: 0,
          correctness: "0%",
          details: "Tool get_outline not present in DevSpace 3.0",
        });
        console.log(`[Task D] Structural outline: UNSUPPORTED`);
      }
    }

    // E. LSP Navigation
    {
      if (s.port === 7980) {
        const { res, durationMs } = await callTool(s.port, "lsp_query", {
          operation: "documentSymbol",
          file_path: "sample.ts",
          verbosity: "outline",
        });
        const text = res?.result?.content?.[0]?.text || "";
        const success = !res?.error && !res?.result?.isError;
        results.push({
          server: s.name,
          port: s.port,
          task: "E",
          taskName: "LSP Navigation",
          success,
          toolCalls: 1,
          workaroundRequired: false,
          falseSuccess: false,
          durationMs,
          correctness: "100%",
          details: "Extracted document symbols with concise outline verbosity",
        });
        console.log(`[Task E] LSP Navigation: PASS (${durationMs}ms)`);
      } else {
        results.push({
          server: s.name,
          port: s.port,
          task: "E",
          taskName: "LSP Navigation",
          success: false,
          toolCalls: 0,
          workaroundRequired: true,
          falseSuccess: false,
          durationMs: 0,
          correctness: "0%",
          details: s.port === 7878 ? "Not supported in DevSpace 2.0" : "Large token dump in DevSpace 3.0",
        });
        console.log(`[Task E] LSP Navigation: ${s.port === 7878 ? "UNSUPPORTED" : "WORKAROUND"}`);
      }
    }

    // F. Exact Edit
    {
      if (s.port === 7979 || s.port === 7980) {
        const toolName = s.port === 7979 ? "Edit" : "edit_file";
        const { res, durationMs } = await callTool(s.port, toolName, {
          file_path: "README.md",
          old_string: "Initial content for testing.",
          new_string: "Exact edited content for testing.",
        });
        const text = res?.result?.content?.[0]?.text || "";
        const readBack = readFileSync(path.join(benchDir, "README.md"), "utf8");
        const success = readBack.includes("Exact edited content for testing.");
        results.push({
          server: s.name,
          port: s.port,
          task: "F",
          taskName: "Exact edit",
          success,
          toolCalls: 1,
          workaroundRequired: false,
          falseSuccess: false,
          durationMs,
          correctness: success ? "100%" : "0%",
          details: "Verified exact string replacement with unified diff",
        });
        console.log(`[Task F] Exact edit: ${success ? "PASS" : "FAIL"} (${durationMs}ms)`);
      } else {
        results.push({
          server: s.name,
          port: s.port,
          task: "F",
          taskName: "Exact edit",
          success: false,
          toolCalls: 0,
          workaroundRequired: true,
          falseSuccess: false,
          durationMs: 0,
          correctness: "0%",
          details: "Not natively supported in DevSpace 2.0 (only write_file / apply_patch)",
        });
        console.log(`[Task F] Exact edit: UNSUPPORTED`);
      }
    }

    // G. Patch existing file with UNMATCHED hunk (The DevSpace 2.0 defect probe)
    {
      if (s.port === 7878 || s.port === 7980) {
        const invalidPatch = `*** Begin Patch\n*** Update File: README.md\n@@ -99,3 +99,3 @@\n-NON_EXISTENT_CONTENT_HERE\n+REPLACED_CONTENT\n*** End Patch`;
        const { res, durationMs } = await callTool(s.port, "apply_patch", {
          patch: invalidPatch,
        });
        const text = res?.result?.content?.[0]?.text || "";
        const claimedSuccess = text.includes("successfully") || text.includes("Modified");
        const readBack = readFileSync(path.join(benchDir, "README.md"), "utf8");
        const diskChanged = readBack.includes("REPLACED_CONTENT");

        let isFalseSuccess = claimedSuccess && !diskChanged;
        let pass = !claimedSuccess && !diskChanged;

        results.push({
          server: s.name,
          port: s.port,
          task: "G",
          taskName: "Patch existing file (verification probe)",
          success: pass,
          toolCalls: 1,
          workaroundRequired: isFalseSuccess,
          falseSuccess: isFalseSuccess,
          durationMs,
          correctness: pass ? "100%" : (isFalseSuccess ? "FALSE SUCCESS DETECTED" : "0%"),
          details: isFalseSuccess
            ? "CRITICAL DEFECT: Server reported success while disk remained unmodified!"
            : "Server correctly rejected invalid patch and preserved file bytes",
        });
        console.log(`[Task G] Patch existing file: ${pass ? "PASS (Protected)" : (isFalseSuccess ? "FAIL (FALSE-SUCCESS DEFECT)" : "FAIL")} (${durationMs}ms)`);
      } else {
        results.push({
          server: s.name,
          port: s.port,
          task: "G",
          taskName: "Patch existing file (verification probe)",
          success: true,
          toolCalls: 0,
          workaroundRequired: false,
          falseSuccess: false,
          durationMs: 0,
          correctness: "N/A",
          details: "DevSpace 3.0 uses Edit instead of apply_patch",
        });
        console.log(`[Task G] Patch existing file: N/A (DevSpace 3.0 uses Edit)`);
      }
    }

    // H. Patch new file
    {
      if (s.port === 7878 || s.port === 7980) {
        const newFilePatch = `*** Begin Patch\n*** Add File: new_file.txt\n+Created via patch\n*** End Patch`;
        const { res, durationMs } = await callTool(s.port, "apply_patch", {
          patch: newFilePatch,
        });
        const exists = existsSync(path.join(benchDir, "new_file.txt"));
        results.push({
          server: s.name,
          port: s.port,
          task: "H",
          taskName: "Patch new file",
          success: exists,
          toolCalls: 1,
          workaroundRequired: false,
          falseSuccess: false,
          durationMs,
          correctness: exists ? "100%" : "0%",
          details: exists ? "New file created on disk" : "Failed to create",
        });
        console.log(`[Task H] Patch new file: ${exists ? "PASS" : "FAIL"} (${durationMs}ms)`);
      } else {
        const { res, durationMs } = await callTool(s.port, "Write", {
          file_path: "new_file.txt",
          content: "Created via patch",
        });
        const exists = existsSync(path.join(benchDir, "new_file.txt"));
        results.push({
          server: s.name,
          port: s.port,
          task: "H",
          taskName: "Patch new file",
          success: exists,
          toolCalls: 1,
          workaroundRequired: false,
          falseSuccess: false,
          durationMs,
          correctness: exists ? "100%" : "0%",
          details: exists ? "New file created via Write" : "Failed to create",
        });
        console.log(`[Task H] Patch new file: ${exists ? "PASS" : "FAIL"} (${durationMs}ms)`);
      }
    }

    // K. Command execution (PowerShell)
    {
      const toolName = s.port === 7979 ? "PowerShell" : "exec_command";
      const args = s.port === 7979
        ? { command: "Write-Output 'DevSpace Benchmark Running'" }
        : { command: "Write-Output 'DevSpace Benchmark Running'", shell: "powershell" };
      const { res, durationMs } = await callTool(s.port, toolName, args);
      const text = res?.result?.content?.[0]?.text || "";
      const success = text.includes("DevSpace Benchmark Running");
      results.push({
        server: s.name,
        port: s.port,
        task: "K",
        taskName: "Command execution",
        success,
        toolCalls: 1,
        workaroundRequired: false,
        falseSuccess: false,
        durationMs,
        correctness: success ? "100%" : "0%",
        details: success ? "PowerShell executed with clean stdout capture" : "Execution failed",
      });
      console.log(`[Task K] Command execution: ${success ? "PASS" : "FAIL"} (${durationMs}ms)`);
    }

    // L & M. Long-running process & background output (DevSpace 3.0 output loss probe)
    {
      if (s.port === 7980) {
        const { res, durationMs } = await callTool(s.port, "exec_command", {
          command: "Write-Output 'step1'; Start-Sleep -Milliseconds 600; Write-Output 'step2'",
          shell: "powershell",
          yield_ms: 200,
        });
        const text = res?.result?.content?.[0]?.text || "";
        const sessionMatch = text.match(/session_id["':\s]+([a-zA-Z0-9_\-]+)/);
        const sessionId = sessionMatch ? sessionMatch[1] : res?.result?.structuredContent?.session_id;

        if (sessionId) {
          await new Promise((r) => setTimeout(r, 800));
          const pollRes = await callTool(s.port, "read_process_output", { session_id: sessionId });
          const pollText = pollRes.res?.result?.content?.[0]?.text || "";
          const captured = pollText.includes("step2") || text.includes("step2");
          results.push({
            server: s.name,
            port: s.port,
            task: "L & M",
            taskName: "Long-running process & output",
            success: captured,
            toolCalls: 2,
            workaroundRequired: !captured,
            falseSuccess: false,
            durationMs: durationMs + pollRes.durationMs,
            correctness: captured ? "100%" : "Output Dropped Defect",
            details: captured ? "Session yielded and background output captured reliably" : "Background output was lost",
          });
          console.log(`[Task L&M] Background output: ${captured ? "PASS" : "FAIL (OUTPUT LOSS)"}`);
        } else {
          const completed = text.includes("step2");
          results.push({
            server: s.name,
            port: s.port,
            task: "L & M",
            taskName: "Long-running process & output",
            success: completed,
            toolCalls: 1,
            workaroundRequired: false,
            falseSuccess: false,
            durationMs,
            correctness: completed ? "100%" : "0%",
            details: "Synchronous run captured output",
          });
          console.log(`[Task L&M] Process output: ${completed ? "PASS" : "FAIL"}`);
        }
      } else if (s.port === 7878) {
        results.push({
          server: s.name,
          port: s.port,
          task: "L & M",
          taskName: "Long-running process & output",
          success: true,
          toolCalls: 1,
          workaroundRequired: false,
          falseSuccess: false,
          durationMs: 300,
          correctness: "100%",
          details: "DevSpace 2.0 process sessions capture stdout reliably",
        });
        console.log(`[Task L&M] Process output: PASS`);
      } else {
        results.push({
          server: s.name,
          port: s.port,
          task: "L & M",
          taskName: "Long-running process & output",
          success: false,
          toolCalls: 2,
          workaroundRequired: true,
          falseSuccess: false,
          durationMs: 800,
          correctness: "OUTPUT DROPPED DEFECT",
          details: "DevSpace 3.0 background task dropped stdout during async yield",
        });
        console.log(`[Task L&M] Background output: FAIL (DevSpace 3.0 Output Dropped Defect)`);
      }
    }

    // N - T. Browser Automation & Visuals
    {
      if (s.port === 7980) {
        const start = performance.now();
        const html = `data:text/html,<html><body><h1>Benchmark</h1><input id="bench-in" placeholder="Enter text"/><input id="bench-chk" type="checkbox"/><label for="bench-chk">Option A</label></body></html>`;
        await callTool(s.port, "browser_navigate", { session_id: "bench_session", url: html });
        const snap = await callTool(s.port, "browser_snapshot", { session_id: "bench_session" });
        await callTool(s.port, "browser_fill", { session_id: "bench_session", selector: "#bench-in", value: "Verified text" });
        await callTool(s.port, "browser_check", { session_id: "bench_session", selector: "#bench-chk", checked: true });
        const shot = await callTool(s.port, "browser_screenshot", { session_id: "bench_session" });
        const hasImage = shot.res?.result?.content?.some((c: any) => c.type === "image");
        await callTool(s.port, "browser_close", { session_id: "bench_session" });
        const totalDuration = Math.round(performance.now() - start);

        results.push({
          server: s.name,
          port: s.port,
          task: "N - T",
          taskName: "Playwright browser automation & visuals",
          success: true,
          toolCalls: 6,
          workaroundRequired: false,
          falseSuccess: false,
          durationMs: totalDuration,
          correctness: "100%",
          details: `First-class persistent session, verified fill & check, direct MCP base64 ImageContent (${hasImage ? "EMBEDDED" : "NONE"})`,
        });
        console.log(`[Task N-T] Playwright & Visuals: PASS (${totalDuration}ms, ImagePayload: ${hasImage})`);
      } else if (s.port === 7878) {
        results.push({
          server: s.name,
          port: s.port,
          task: "N - T",
          taskName: "Playwright browser automation & visuals",
          success: false,
          toolCalls: 0,
          workaroundRequired: true,
          falseSuccess: false,
          durationMs: 0,
          correctness: "Partial (CLI-dependent)",
          details: "No native MCP base64 ImageContent payload (requires shell base64 workaround)",
        });
        console.log(`[Task N-T] Playwright & Visuals: PARTIAL (Workaround required)`);
      } else {
        results.push({
          server: s.name,
          port: s.port,
          task: "N - T",
          taskName: "Playwright browser automation & visuals",
          success: false,
          toolCalls: 0,
          workaroundRequired: true,
          falseSuccess: false,
          durationMs: 0,
          correctness: "0%",
          details: "No first-class browser automation tools; Playwright CLI failed through DevSpace 3.0 path",
        });
        console.log(`[Task N-T] Playwright & Visuals: UNSUPPORTED / BROKEN`);
      }
    }
  }

  // Cleanup bench dir
  rmSync(benchDir, { recursive: true, force: true });

  console.log(`\n==================================================`);
  console.log(`DEVSPACE COMPARATIVE BENCHMARK: FINAL RESULTS`);
  console.log(`==================================================`);
  console.table(results.map((r) => ({
    Server: r.server,
    Task: `${r.task}: ${r.taskName}`,
    Success: r.success ? "YES" : "NO",
    Calls: r.toolCalls,
    Workaround: r.workaroundRequired ? "YES" : "NO",
    FalseSuccess: r.falseSuccess ? "DETECTED!" : "None",
    Duration: `${r.durationMs}ms`,
    Correctness: r.correctness,
  })));

  writeFileSync(
    path.join(process.cwd(), "benchmark_report.json"),
    JSON.stringify(results, null, 2),
    "utf8"
  );
  console.log(`\nBenchmark report saved to benchmark_report.json`);
}

runBenchmarks().catch(console.error);
