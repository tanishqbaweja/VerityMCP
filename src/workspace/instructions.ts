import fs from "node:fs/promises";
import path from "node:path";

export async function loadInstructions(workspaceRoot: string): Promise<string> {
  const instructionFiles = ["AGENTS.md", "CHATGPT.md", "CONVENTIONS.md"];
  const collected: string[] = [];

  for (const file of instructionFiles) {
    const fullPath = path.join(workspaceRoot, file);
    try {
      const content = await fs.readFile(fullPath, "utf-8");
      if (content.trim()) {
        collected.push(`=== ${file} ===\n${content.trim()}`);
      }
    } catch {}
  }

  return collected.join("\n\n");
}
