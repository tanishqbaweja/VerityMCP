import { spawnSync } from "node:child_process";
import path from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { resolveWorkspacePath } from "../security/roots.js";
import type { StandardToolResponse } from "../types/index.js";

export interface SearchMatch {
  filePath: string;
  line: number;
  column: number;
  lineText: string;
}

export interface SearchCodeOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  query: string;
  dirPath?: string;
  caseSensitive?: boolean;
  maxResults?: number;
  globFilter?: string;
}

export interface SearchCodeData {
  query: string;
  matches: SearchMatch[];
  totalMatches: number;
  filesMatchedCount: number;
}

export function executeSearchCode(
  options: SearchCodeOptions
): StandardToolResponse<SearchCodeData> {
  const startTime = Date.now();
  const {
    workspaceRoot,
    allowedRoots = [],
    query,
    dirPath = ".",
    caseSensitive = false,
    maxResults = 100,
    globFilter,
  } = options;

  let searchDir: string;
  try {
    searchDir = resolveWorkspacePath(workspaceRoot, dirPath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      action: `search_code "${query}"`,
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

  const args: string[] = [
    "--vimgrep",
    "--max-count",
    String(maxResults),
  ];

  if (!caseSensitive) {
    args.push("-i");
  }

  if (globFilter) {
    args.push("-g", globFilter);
  }

  // Add ignore patterns
  args.push("-g", "!node_modules", "-g", "!.git", "-g", "!dist", "-g", "!.pnpm");
  args.push("--", query, ".");

  const rgResult = spawnSync(rgPath, args, {
    cwd: searchDir,
    encoding: "utf-8",
    windowsHide: true,
  });

  const output = rgResult.stdout || "";
  const lines = output.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const matches: SearchMatch[] = [];
  const filesSet = new Set<string>();

  for (const line of lines) {
    if (matches.length >= maxResults) break;
    // Format: path:line:col:text
    const parts = line.split(":");
    if (parts.length >= 4) {
      const relPart = parts[0];
      const lineNum = parseInt(parts[1], 10);
      const colNum = parseInt(parts[2], 10);
      const lineText = parts.slice(3).join(":");

      const fullMatchPath = path.resolve(searchDir, relPart);
      const relToWorkspace = path.relative(workspaceRoot, fullMatchPath).replace(/\\/g, "/");

      matches.push({
        filePath: relToWorkspace,
        line: lineNum,
        column: colNum,
        lineText: lineText.trim(),
      });
      filesSet.add(relToWorkspace);
    }
  }

  const formattedLines = matches.map((m) => `${m.filePath}:${m.line} | ${m.lineText}`);
  const header = `Search for "${query}": Found ${matches.length} match(es) across ${filesSet.size} file(s).`;
  const text = matches.length > 0 ? `${header}\n${formattedLines.join("\n")}` : `No matches found for "${query}".`;

  return {
    success: true,
    action: `search_code "${query}"`,
    text,
    verification: {
      performed: true,
      passed: true,
      method: "ripgrep_binary_search",
      details: { matchCount: matches.length, filesCount: filesSet.size },
    },
    data: {
      query,
      matches,
      totalMatches: matches.length,
      filesMatchedCount: filesSet.size,
    },
    durationMs: Date.now() - startTime,
  };
}
