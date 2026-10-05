import path from "node:path";

export type WorkspaceAccessMode = "open" | "warn" | "restricted";

let currentWorkspaceAccessMode: WorkspaceAccessMode =
  (process.env.VERITY_WORKSPACE_ACCESS_MODE as WorkspaceAccessMode) || "warn";

export function setWorkspaceAccessMode(mode: WorkspaceAccessMode): void {
  currentWorkspaceAccessMode = mode;
}

export function getWorkspaceAccessMode(): WorkspaceAccessMode {
  return currentWorkspaceAccessMode;
}

/**
 * Normalizes a path for consistent cross-platform containment comparison.
 */
export function normalizePath(p: string): string {
  let resolved = path.resolve(p);
  // Lowercase drive letter on Windows for case-insensitive comparison
  if (process.platform === "win32" && /^[a-zA-Z]:/.test(resolved)) {
    resolved = resolved[0].toLowerCase() + resolved.slice(1);
  }
  return path.normalize(resolved);
}

/**
 * Checks whether targetPath is contained within rootPath.
 */
export function isPathContained(targetPath: string, rootPath: string): boolean {
  const normTarget = normalizePath(targetPath);
  const normRoot = normalizePath(rootPath);

  if (normTarget === normRoot) return true;

  const relative = path.relative(normRoot, normTarget);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Asserts that targetPath is contained within at least one allowed root.
 */
export function assertPathWithinRoots(targetPath: string, allowedRoots: string[]): string {
  const normTarget = normalizePath(targetPath);

  if (allowedRoots.length === 0) {
    return normTarget;
  }

  const isAllowed = allowedRoots.some((root) => isPathContained(normTarget, root));
  if (!isAllowed) {
    throw new Error(
      `Access denied: Path "${targetPath}" is outside allowed roots (${allowedRoots.join(", ")}).`
    );
  }

  return normTarget;
}

export interface PathResolution {
  resolvedPath: string;
  withinWorkspace: boolean;
  workspaceRoot: string;
  warning?: string;
}

/**
 * Resolves a path that may be relative to workspaceRoot or explicit absolute path.
 * Supports open, warn, and restricted modes.
 */
export function resolvePathWithWorkspace(
  workspaceRoot: string,
  subPath: string,
  allowedRoots: string[] = [],
  explicitMode?: WorkspaceAccessMode
): PathResolution {
  const mode = explicitMode || getWorkspaceAccessMode();
  const normWorkspaceRoot = normalizePath(workspaceRoot);
  const isAbs = path.isAbsolute(subPath);

  const resolved = isAbs
    ? normalizePath(subPath)
    : normalizePath(path.join(normWorkspaceRoot, subPath));

  const withinWorkspace = isPathContained(resolved, normWorkspaceRoot);

  if (mode === "restricted") {
    if (!withinWorkspace) {
      throw new Error(`Access denied: Path "${subPath}" escapes workspace root "${workspaceRoot}".`);
    }
    if (allowedRoots && allowedRoots.length > 0) {
      assertPathWithinRoots(resolved, allowedRoots);
    }
    return {
      resolvedPath: resolved,
      withinWorkspace: true,
      workspaceRoot: normWorkspaceRoot,
    };
  }

  // In "open" or "warn" mode, external paths are allowed
  let warning: string | undefined;
  if (!withinWorkspace && mode === "warn") {
    warning = `Target "${resolved}" is outside active workspace ("${normWorkspaceRoot}").`;
  }

  return {
    resolvedPath: resolved,
    withinWorkspace,
    workspaceRoot: normWorkspaceRoot,
    warning,
  };
}

/**
 * Backwards-compatible resolver for operations that only need the string path.
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  subPath: string,
  allowedRoots?: string[],
  explicitMode?: WorkspaceAccessMode
): string {
  return resolvePathWithWorkspace(workspaceRoot, subPath, allowedRoots, explicitMode).resolvedPath;
}
