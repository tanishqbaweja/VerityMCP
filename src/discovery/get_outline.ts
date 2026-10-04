import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../security/roots.js";
import type { StandardToolResponse, FileOutline, FileOutlineSymbol } from "../types/index.js";

export interface GetOutlineOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  filePath: string;
  verbosity?: "minimal" | "detailed";
}

export async function executeGetOutline(
  options: GetOutlineOptions
): Promise<StandardToolResponse<FileOutline>> {
  const startTime = Date.now();
  const { workspaceRoot, allowedRoots = [], filePath, verbosity = "detailed" } = options;

  let resolvedPath: string;
  try {
    resolvedPath = resolveWorkspacePath(workspaceRoot, filePath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      action: `get_outline "${filePath}"`,
      text: `Path validation failed: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "path_containment_check",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  let content: string;
  try {
    content = await fs.readFile(resolvedPath, "utf-8");
  } catch (err: any) {
    return {
      success: false,
      action: `get_outline "${filePath}"`,
      text: `Failed to read file: ${err.message}`,
      verification: {
        performed: true,
        passed: false,
        method: "fs_read",
        error: err.message,
      },
      durationMs: Date.now() - startTime,
    };
  }

  const ext = path.extname(filePath).toLowerCase();
  const lines = content.split(/\r?\n/);
  const symbols: FileOutlineSymbol[] = [];

  // Robust regex pattern matching across languages
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    const lineNum = idx + 1;

    // TypeScript / JavaScript
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
      const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/);
      if (classMatch) {
        symbols.push({ name: classMatch[1], kind: "class", line: lineNum, signature: trimmed });
        continue;
      }

      const ifaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/);
      if (ifaceMatch) {
        symbols.push({ name: ifaceMatch[1], kind: "interface", line: lineNum, signature: trimmed });
        continue;
      }

      const typeMatch = trimmed.match(/^(?:export\s+)?type\s+([A-Za-z0-9_$]+)/);
      if (typeMatch) {
        symbols.push({ name: typeMatch[1], kind: "type", line: lineNum, signature: trimmed });
        continue;
      }

      const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/);
      if (fnMatch) {
        symbols.push({ name: fnMatch[1], kind: "function", line: lineNum, signature: trimmed });
        continue;
      }

      const arrowFnMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/);
      if (arrowFnMatch) {
        symbols.push({ name: arrowFnMatch[1], kind: "function", line: lineNum, signature: trimmed });
        continue;
      }

      const methodMatch = trimmed.match(/^(?:public|private|protected|static|async)?\s*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*[:{]/);
      if (methodMatch && !["if", "for", "while", "switch", "catch"].includes(methodMatch[1])) {
        symbols.push({ name: methodMatch[1], kind: "method", line: lineNum, signature: trimmed });
        continue;
      }
    }

    // Python
    if (ext === ".py") {
      const pyClassMatch = trimmed.match(/^class\s+([A-Za-z0-9_]+)/);
      if (pyClassMatch) {
        symbols.push({ name: pyClassMatch[1], kind: "class", line: lineNum, signature: trimmed });
        continue;
      }

      const pyFnMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)/);
      if (pyFnMatch) {
        symbols.push({ name: pyFnMatch[1], kind: "function", line: lineNum, signature: trimmed });
        continue;
      }
    }

    // Rust
    if (ext === ".rs") {
      const rustFn = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/);
      if (rustFn) {
        symbols.push({ name: rustFn[1], kind: "function", line: lineNum, signature: trimmed });
        continue;
      }

      const rustStruct = trimmed.match(/^(?:pub\s+)?struct\s+([A-Za-z0-9_]+)/);
      if (rustStruct) {
        symbols.push({ name: rustStruct[1], kind: "class", line: lineNum, signature: trimmed });
        continue;
      }
    }

    // Go
    if (ext === ".go") {
      const goFn = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_]+)/);
      if (goFn) {
        symbols.push({ name: goFn[1], kind: "function", line: lineNum, signature: trimmed });
        continue;
      }
    }
  }

  const lang = ext.replace(".", "") || "text";
  const outlineData: FileOutline = {
    filePath,
    language: lang,
    symbols,
  };

  const formattedLines = symbols.map((s) => {
    const kindPad = `[${s.kind}]`.padEnd(12, " ");
    return verbosity === "detailed" && s.signature
      ? `Line ${s.line.toString().padStart(4, " ")} | ${kindPad} ${s.signature}`
      : `Line ${s.line.toString().padStart(4, " ")} | ${kindPad} ${s.name}`;
  });

  const header = `Outline for "${filePath}" (${symbols.length} symbol(s) detected):`;
  const text = symbols.length > 0 ? `${header}\n${formattedLines.join("\n")}` : `No structural symbols found in "${filePath}".`;

  return {
    success: true,
    action: `get_outline "${filePath}"`,
    text,
    verification: {
      performed: true,
      passed: true,
      method: "symbol_regex_parse",
      details: { symbolsCount: symbols.length, language: lang },
    },
    data: outlineData,
    durationMs: Date.now() - startTime,
  };
}
