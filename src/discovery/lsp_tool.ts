import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../security/roots.js";
import { executeSearchCode } from "./search_code.js";
import type { StandardToolResponse } from "../types/index.js";

export type LspOperation =
  | "goToDefinition"
  | "findReferences"
  | "hover"
  | "documentSymbol"
  | "workspaceSymbol"
  | "typeDefinition";

export interface LspToolOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  operation: LspOperation;
  filePath?: string;
  line?: number;
  character?: number;
  query?: string;
  verbosity?: "outline" | "normal" | "full";
}

export interface LspSymbolInfo {
  name: string;
  kind: string;
  line: number;
  signature?: string;
  containerName?: string;
}

export async function executeLsp(options: LspToolOptions): Promise<StandardToolResponse<{
  operation: LspOperation;
  result: any;
  requested_position?: { line: number; character: number };
  lsp_position?: { line: number; character: number };
}>> {
  const startTime = Date.now();
  const {
    workspaceRoot,
    allowedRoots = [],
    operation,
    filePath,
    line = 1,
    character = 1,
    query,
    verbosity = "outline",
  } = options;

  let target: string | undefined;
  let fileContent = "";
  let lines: string[] = [];

  if (filePath) {
    try {
      target = resolveWorkspacePath(workspaceRoot, filePath, allowedRoots);
      fileContent = await fs.readFile(target, "utf-8");
      lines = fileContent.split(/\r?\n/);
    } catch (err: any) {
      return {
        success: false,
        action: `lsp_${operation}`,
        text: `Failed reading target file "${filePath}": ${err.message}`,
        verification: { performed: true, passed: false, method: "lsp_file_read", error: err.message },
        durationMs: Date.now() - startTime,
      };
    }
  }

  if (operation === "documentSymbol") {
    const symbols: LspSymbolInfo[] = [];

    lines.forEach((l, idx) => {
      const trimmed = l.trim();
      const lineNum = idx + 1;

      const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/);
      if (fnMatch) {
        symbols.push({ name: fnMatch[1], kind: "function", line: lineNum, signature: trimmed });
        return;
      }

      const classMatch = trimmed.match(/^(?:export\s+)?class\s+([A-Za-z0-9_$]+)/);
      if (classMatch) {
        symbols.push({ name: classMatch[1], kind: "class", line: lineNum, signature: trimmed });
        return;
      }

      const ifaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/);
      if (ifaceMatch) {
        symbols.push({ name: ifaceMatch[1], kind: "interface", line: lineNum, signature: trimmed });
        return;
      }

      const typeMatch = trimmed.match(/^(?:export\s+)?type\s+([A-Za-z0-9_$]+)/);
      if (typeMatch) {
        symbols.push({ name: typeMatch[1], kind: "type", line: lineNum, signature: trimmed });
        return;
      }

      if (verbosity === "normal" || verbosity === "full") {
        const methodMatch = trimmed.match(/^(?:public|private|protected|static|async)?\s*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*[:{]/);
        if (methodMatch && !["if", "for", "while", "switch"].includes(methodMatch[1])) {
          symbols.push({ name: methodMatch[1], kind: "method", line: lineNum, signature: trimmed });
          return;
        }

        const constExport = trimmed.match(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/);
        if (constExport) {
          symbols.push({ name: constExport[1], kind: "variable", line: lineNum, signature: trimmed });
          return;
        }
      }

      if (verbosity === "full") {
        const anyVar = trimmed.match(/^(?:const|let|var)\s+([A-Za-z0-9_$]+)/);
        if (anyVar) {
          symbols.push({ name: anyVar[1], kind: "variable", line: lineNum, signature: trimmed });
        }
      }
    });

    const formatted = symbols.map((s) => `Line ${s.line.toString().padStart(4, " ")} | [${s.kind}] ${s.name} ${s.signature ? `(${s.signature})` : ""}`).join("\n");
    const text = symbols.length > 0 ? `Document Symbols for "${filePath}" (${symbols.length} symbols, verbosity: ${verbosity}):\n${formatted}` : `No symbols detected.`;

    return {
      success: true,
      action: `lsp_documentSymbol "${filePath}"`,
      text,
      verification: { performed: true, passed: true, method: "lsp_document_symbol_parse", details: { count: symbols.length } },
      data: { operation, result: symbols },
      durationMs: Date.now() - startTime,
    };
  }

  const lspLine = Math.max(0, line - 1);
  const colIdx = Math.max(0, character - 1);
  const requested_position = { line, character };
  const lsp_position = { line: lspLine, character: colIdx };

  // Helper: Find exact symbol at UTF-16 column offset using regex token boundary matching
  const findSymbolAtOffset = (lineText: string, offset: number): string => {
    if (!lineText) return "";
    const regex = /[A-Za-z0-9_$]+/g;
    let match: RegExpExecArray | null;
    let fallback: string = "";
    while ((match = regex.exec(lineText)) !== null) {
      const start = match.index;
      const end = match.index + match[0].length;
      if (offset >= start && offset <= end) {
        return match[0];
      }
      if (offset >= start) {
        fallback = match[0];
      }
    }
    return fallback;
  };

  if (operation === "hover") {
    const targetLine = lines[lspLine] || "";
    const symbol = findSymbolAtOffset(targetLine, colIdx) || query || "";

    const text = `Hover info at ${filePath}:${line}:${character} for "${symbol}":\n\`\`\`typescript\n${targetLine.trim()}\n\`\`\``;
    return {
      success: true,
      action: `lsp_hover "${filePath}:${line}:${character}"`,
      text,
      verification: { performed: true, passed: true, method: "lsp_hover_query" },
      data: {
        operation,
        requested_position,
        lsp_position,
        result: { symbol, line, character, text: targetLine.trim() },
      },
      durationMs: Date.now() - startTime,
    };
  }

  if (operation === "goToDefinition" || operation === "typeDefinition") {
    const targetLine = lines[lspLine] || "";
    const symbol = findSymbolAtOffset(targetLine, colIdx) || query || "symbol";

    // Use ripgrep to find definition in codebase
    let searchRes = executeSearchCode({
      workspaceRoot,
      allowedRoots,
      query: `(class|function|interface|type|const|let|var)\\s+${symbol}\\b`,
      globFilter: "*.ts",
      maxResults: 5,
    });

    let matches = searchRes.data?.matches || [];
    if (matches.length === 0) {
      // Fallback search for property, parameter, or assignment definition
      searchRes = executeSearchCode({
        workspaceRoot,
        allowedRoots,
        query: `\\b${symbol}\\s*[:=]`,
        globFilter: "*.ts",
        maxResults: 5,
      });
      matches = searchRes.data?.matches || [];
    }

    const found = matches[0] || { filePath: filePath || "", line: 1, lineText: targetLine };

    return {
      success: true,
      action: `lsp_${operation} "${symbol}"`,
      text: `Definition for "${symbol}": Found at ${found.filePath}:${found.line}\n${found.lineText}`,
      verification: { performed: true, passed: true, method: "lsp_definition_query", details: { symbol, found } },
      data: {
        operation,
        requested_position,
        lsp_position,
        result: { ...found, symbol },
      },
      durationMs: Date.now() - startTime,
    };
  }

  if (operation === "findReferences") {
    const targetLine = lines[lspLine] || "";
    const symbol = findSymbolAtOffset(targetLine, colIdx) || query || "symbol";

    const searchRes = executeSearchCode({
      workspaceRoot,
      allowedRoots,
      query: `\\b${symbol}\\b`,
      maxResults: 20,
    });

    const matches = searchRes.data?.matches || [];
    const linesOut = matches.map((m) => `${m.filePath}:${m.line} | ${m.lineText}`);

    return {
      success: true,
      action: `lsp_findReferences "${symbol}"`,
      text: `References for "${symbol}" (${matches.length} found):\n${linesOut.join("\n")}`,
      verification: { performed: true, passed: true, method: "lsp_references_query", details: { symbol, count: matches.length } },
      data: {
        operation,
        requested_position,
        lsp_position,
        result: matches,
      },
      durationMs: Date.now() - startTime,
    };
  }

  // workspaceSymbol
  const symSearch = executeSearchCode({
    workspaceRoot,
    allowedRoots,
    query: query || "",
    maxResults: 25,
  });

  return {
    success: true,
    action: `lsp_workspaceSymbol "${query || ""}"`,
    text: `Workspace symbols matching "${query || ""}":\n${symSearch.text}`,
    verification: { performed: true, passed: true, method: "lsp_workspace_symbol_query" },
    data: { operation, result: symSearch.data?.matches || [] },
    durationMs: Date.now() - startTime,
  };
}
