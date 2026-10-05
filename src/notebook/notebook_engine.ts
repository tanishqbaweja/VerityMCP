import fs from "node:fs/promises";
import { resolveWorkspacePath } from "../security/roots.js";
import { verifyFileContent } from "../verification/index.js";
import type { StandardToolResponse } from "../types/index.js";

export interface NotebookCellSummary {
  index: number;
  id?: string;
  type: "code" | "markdown" | "raw";
  sourcePreview: string;
  source: string;
  executionCount?: number | null;
  outputsCount?: number;
}

export interface ReadNotebookData {
  notebookPath: string;
  nbformat: number;
  totalCells: number;
  cells: NotebookCellSummary[];
}

export async function executeReadNotebook(options: {
  workspaceRoot: string;
  allowedRoots?: string[];
  notebookPath: string;
}): Promise<StandardToolResponse<ReadNotebookData>> {
  const startTime = Date.now();
  const { workspaceRoot, allowedRoots = [], notebookPath } = options;

  let target: string;
  try {
    target = resolveWorkspacePath(workspaceRoot, notebookPath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      action: `read_notebook "${notebookPath}"`,
      text: err.message,
      verification: { performed: true, passed: false, method: "path_containment_check", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const raw = await fs.readFile(target, "utf-8");
    const nb = JSON.parse(raw);

    if (!nb.cells || !Array.isArray(nb.cells)) {
      return {
        success: false,
        action: `read_notebook "${notebookPath}"`,
        text: `Invalid notebook format in "${notebookPath}": missing cells array.`,
        verification: { performed: true, passed: false, method: "json_schema_check", error: "Missing cells" },
        durationMs: Date.now() - startTime,
      };
    }

    const cells: NotebookCellSummary[] = nb.cells.map((c: any, idx: number) => {
      const src = Array.isArray(c.source) ? c.source.join("") : String(c.source || "");
      return {
        index: idx + 1,
        id: c.id,
        type: c.cell_type || "code",
        sourcePreview: src.slice(0, 100).replace(/\r?\n/g, " "),
        source: src,
        executionCount: c.execution_count,
        outputsCount: Array.isArray(c.outputs) ? c.outputs.length : 0,
      };
    });

    const lines = [
      `Notebook: ${notebookPath} (Format v${nb.nbformat || 4}, ${cells.length} cells)`,
      "--- Cells ---",
      ...cells.map(
        (c) =>
          `[Cell #${c.index} | ${c.type.toUpperCase()}${c.id ? ` id=${c.id}` : ""}] ${c.sourcePreview}`
      ),
    ];

    return {
      success: true,
      action: `read_notebook "${notebookPath}"`,
      text: lines.join("\n"),
      verification: {
        performed: true,
        passed: true,
        method: "notebook_json_parse",
        details: { totalCells: cells.length },
      },
      data: {
        notebookPath,
        nbformat: nb.nbformat || 4,
        totalCells: cells.length,
        cells,
      },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: `read_notebook "${notebookPath}"`,
      text: `Failed reading notebook: ${err.message}`,
      verification: { performed: true, passed: false, method: "fs_read_json", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}

export interface EditNotebookOptions {
  workspaceRoot: string;
  allowedRoots?: string[];
  notebookPath: string;
  cellId?: string;
  cellIndex?: number;
  newSource: string;
  cellType?: "code" | "markdown";
  editMode?: "replace" | "insert" | "delete";
}

export function detectJsonFormatting(raw: string): { indent: number | string; trailingNewline: string } {
  const trailingNewline = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
  const lines = raw.split(/\r?\n/);
  if (lines.length <= 1) {
    return { indent: 0, trailingNewline };
  }

  for (const line of lines) {
    const match = line.match(/^(\s+)\S/);
    if (match) {
      const indentStr = match[1];
      if (indentStr.startsWith("\t")) {
        return { indent: "\t", trailingNewline };
      }
      return { indent: indentStr.length, trailingNewline };
    }
  }

  return { indent: 2, trailingNewline };
}

export async function executeEditNotebook(
  options: EditNotebookOptions
): Promise<StandardToolResponse<{ notebookPath: string; totalCells: number; cellId?: string }>> {
  const startTime = Date.now();
  const {
    workspaceRoot,
    allowedRoots = [],
    notebookPath,
    cellId,
    cellIndex,
    newSource,
    cellType = "code",
    editMode = "replace",
  } = options;

  let target: string;
  try {
    target = resolveWorkspacePath(workspaceRoot, notebookPath, allowedRoots);
  } catch (err: any) {
    return {
      success: false,
      action: `edit_notebook "${notebookPath}"`,
      text: err.message,
      verification: { performed: true, passed: false, method: "path_containment_check", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const raw = await fs.readFile(target, "utf-8");
    const nb = JSON.parse(raw);

    if (!nb.cells || !Array.isArray(nb.cells)) {
      throw new Error(`Invalid Jupyter notebook format: missing cells array.`);
    }

    const cells = nb.cells;
    let targetIndex = -1;

    if (cellId) {
      targetIndex = cells.findIndex((c: any) => c.id === cellId);
      if (targetIndex === -1 && editMode !== "insert") {
        throw new Error(`Cell with ID "${cellId}" not found in notebook.`);
      }
    } else if (cellIndex !== undefined && cellIndex > 0 && cellIndex <= cells.length) {
      targetIndex = cellIndex - 1;
    }

    const formatSource = (src: string) =>
      src.split("\n").map((line, i, arr) => (i < arr.length - 1 ? line + "\n" : line));

    if (editMode === "delete") {
      if (targetIndex === -1) {
        throw new Error("Must provide cell_id or valid cell_index to delete a cell.");
      }
      cells.splice(targetIndex, 1);
    } else if (editMode === "insert") {
      const newCell: any = {
        id: `cell_${Date.now().toString(36)}`,
        cell_type: cellType,
        metadata: {},
        source: formatSource(newSource),
      };
      if (cellType === "code") {
        newCell.execution_count = null;
        newCell.outputs = [];
      }
      if (targetIndex !== -1) {
        cells.splice(targetIndex + 1, 0, newCell);
      } else {
        cells.push(newCell);
      }
    } else {
      // replace
      if (targetIndex === -1) {
        if (cells.length === 0) {
          throw new Error("Notebook has no cells. Use edit_mode='insert' to add a cell.");
        }
        targetIndex = 0;
      }
      const cell = cells[targetIndex];
      if (cellType) cell.cell_type = cellType;
      cell.source = formatSource(newSource);
      if (cell.cell_type === "code") {
        cell.outputs = [];
        cell.execution_count = null;
      }
    }

    const formatting = detectJsonFormatting(raw);
    const newContent =
      (formatting.indent === 0
        ? JSON.stringify(nb)
        : JSON.stringify(nb, null, formatting.indent)) + formatting.trailingNewline;
    await fs.writeFile(target, newContent, "utf-8");

    // MANDATORY POST-MUTATION VERIFICATION
    const verifyRes = await verifyFileContent(target, newContent);
    if (!verifyRes.passed) {
      return {
        success: false,
        action: `edit_notebook "${notebookPath}"`,
        text: `CRITICAL: Notebook edit failed post-write verification.`,
        verification: verifyRes,
        durationMs: Date.now() - startTime,
      };
    }

    return {
      success: true,
      action: `edit_notebook "${notebookPath}" (mode: ${editMode})`,
      text: `Successfully updated notebook "${notebookPath}" (mode: ${editMode}, total cells: ${cells.length}).`,
      verification: verifyRes,
      data: {
        notebookPath,
        totalCells: cells.length,
        cellId: cellId || (targetIndex >= 0 ? cells[targetIndex]?.id : undefined),
      },
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      success: false,
      action: `edit_notebook "${notebookPath}"`,
      text: `Notebook edit failed: ${err.message}`,
      verification: { performed: true, passed: false, method: "notebook_edit", error: err.message },
      durationMs: Date.now() - startTime,
    };
  }
}
