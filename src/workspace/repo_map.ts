import fs from "node:fs/promises";
import path from "node:path";
import type { RepoMap } from "../types/index.js";

const COMMON_IGNORE = new Set([
  ".git",
  "node_modules",
  ".pnpm",
  "dist",
  "build",
  ".cache",
  ".next",
  ".turbo",
]);

export async function generateRepoMap(workspaceRoot: string): Promise<RepoMap> {
  const primaryDirectories: string[] = [];
  const manifests: string[] = [];
  const scripts: Record<string, string> = {};
  const dependencies: string[] = [];
  const detectedLanguages = new Set<string>();

  try {
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });

    for (const ent of entries) {
      if (COMMON_IGNORE.has(ent.name)) continue;

      if (ent.isDirectory()) {
        if (!ent.name.startsWith(".")) {
          primaryDirectories.push(ent.name);
        }
      } else if (ent.isFile()) {
        const name = ent.name;

        // Check manifests
        if (
          name === "package.json" ||
          name === "Cargo.toml" ||
          name === "pyproject.toml" ||
          name === "go.mod" ||
          name === "pom.xml" ||
          name === "composer.json" ||
          name === "Gemfile"
        ) {
          manifests.push(name);
        }

        // Language hints from extensions
        const ext = path.extname(name).toLowerCase();
        if (ext === ".ts" || ext === ".tsx") detectedLanguages.add("TypeScript");
        else if (ext === ".js" || ext === ".jsx") detectedLanguages.add("JavaScript");
        else if (ext === ".py") detectedLanguages.add("Python");
        else if (ext === ".rs") detectedLanguages.add("Rust");
        else if (ext === ".go") detectedLanguages.add("Go");
      }
    }

    // Inspect package.json if present
    const pkgPath = path.join(workspaceRoot, "package.json");
    try {
      const pkgContent = await fs.readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(pkgContent);

      if (pkg.scripts && typeof pkg.scripts === "object") {
        for (const [k, v] of Object.entries(pkg.scripts)) {
          if (typeof v === "string") scripts[k] = v;
        }
      }

      if (pkg.dependencies && typeof pkg.dependencies === "object") {
        dependencies.push(...Object.keys(pkg.dependencies).slice(0, 20));
      }
      if (pkg.devDependencies && typeof pkg.devDependencies === "object") {
        for (const devDep of Object.keys(pkg.devDependencies)) {
          if (dependencies.length < 35 && !dependencies.includes(devDep)) {
            dependencies.push(devDep);
          }
        }
      }

      if (!detectedLanguages.has("TypeScript") && (pkg.devDependencies?.typescript || pkg.dependencies?.typescript)) {
        detectedLanguages.add("TypeScript");
      }
      if (detectedLanguages.size === 0) {
        detectedLanguages.add("JavaScript / Node.js");
      }
    } catch {}

    // Check subdirectories for languages if still empty
    if (primaryDirectories.includes("src")) {
      try {
        const srcEntries = await fs.readdir(path.join(workspaceRoot, "src"));
        for (const f of srcEntries) {
          if (f.endsWith(".ts")) detectedLanguages.add("TypeScript");
          if (f.endsWith(".py")) detectedLanguages.add("Python");
          if (f.endsWith(".rs")) detectedLanguages.add("Rust");
          if (f.endsWith(".go")) detectedLanguages.add("Go");
        }
      } catch {}
    }
  } catch {}

  const languages = Array.from(detectedLanguages);
  const summary = `Project root containing ${primaryDirectories.length} primary directories (${primaryDirectories.join(", ")}), ${manifests.length} manifest(s), utilizing ${languages.join(", ") || "generic"}.`;

  return {
    summary,
    primaryDirectories,
    manifests,
    scripts,
    dependencies,
    languages,
  };
}
