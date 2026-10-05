import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { SkillInfo } from "../types/index.js";

function parseSkillMetadata(content: string, fallbackName: string): { name: string; description: string } {
  let name = fallbackName;
  let description = "Skill documentation";

  // Check YAML frontmatter: --- name: ... description: ... ---
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const yamlBody = fmMatch[1];
    const nameMatch = yamlBody.match(/^name:\s*(.+)$/m);
    const descMatch = yamlBody.match(/^description:\s*(.+)$/m);
    if (nameMatch) name = nameMatch[1].trim().replace(/^['"]|['"]$/g, "");
    if (descMatch) description = descMatch[1].trim().replace(/^['"]|['"]$/g, "");
    return { name, description };
  }

  // Parse markdown headings
  const titleMatch = content.match(/^#\s+(.+)$/m);
  if (titleMatch) {
    name = titleMatch[1].trim();
  }

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---")) {
      description = trimmed.slice(0, 150);
      break;
    }
  }

  return { name, description };
}

export async function discoverSkills(workspaceRoot: string): Promise<SkillInfo[]> {
  const skillMap = new Map<string, SkillInfo>();

  const searchDirs = [
    // 1. Workspace directories (highest priority)
    { dir: path.join(workspaceRoot, ".agents", "skills"), source: "workspace" as const },
    { dir: path.join(workspaceRoot, ".skills"), source: "workspace" as const },
    { dir: path.join(workspaceRoot, "skills"), source: "workspace" as const },
    // 2. Global directories
    { dir: path.join(os.homedir(), ".codex", "skills"), source: "global" as const },
    { dir: path.join(os.homedir(), ".verity", "skills"), source: "global" as const },
    { dir: path.join(os.homedir(), ".agents", "skills"), source: "global" as const },
  ];

  for (const item of searchDirs) {
    try {
      const entries = await fs.readdir(item.dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (ent.name.startsWith(".")) continue; // skip hidden dirs like .system

        const skillPath = path.join(item.dir, ent.name, "SKILL.md");
        try {
          const content = await fs.readFile(skillPath, "utf-8");
          const meta = parseSkillMetadata(content, ent.name);
          const key = meta.name.toLowerCase();

          // Workspace skills override global skills
          if (!skillMap.has(key) || (item.source === "workspace" && skillMap.get(key)?.source === "global")) {
            skillMap.set(key, {
              name: meta.name,
              description: meta.description,
              path: skillPath,
              source: item.source,
            });
          }
        } catch {}
      }
    } catch {}
  }

  return Array.from(skillMap.values());
}

export async function readSkillContent(
  skillNameOrPath: string,
  workspaceRoot: string
): Promise<{ name: string; content: string; path: string }> {
  // If it's a direct file path
  if (path.isAbsolute(skillNameOrPath) || skillNameOrPath.endsWith(".md")) {
    const fullPath = path.isAbsolute(skillNameOrPath)
      ? skillNameOrPath
      : path.resolve(workspaceRoot, skillNameOrPath);
    const content = await fs.readFile(fullPath, "utf-8");
    return { name: path.basename(path.dirname(fullPath)), content, path: fullPath };
  }

  // Otherwise find by name
  const allSkills = await discoverSkills(workspaceRoot);
  const found = allSkills.find(
    (s) => s.name.toLowerCase() === skillNameOrPath.toLowerCase()
  );
  if (!found) {
    throw new Error(
      `Skill "${skillNameOrPath}" not found. Available skills: ${allSkills.map((s) => s.name).join(", ")}`
    );
  }

  const content = await fs.readFile(found.path, "utf-8");
  return { name: found.name, content, path: found.path };
}
