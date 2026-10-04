import path from "node:path";

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

/**
 * Resolves a path that may be relative to workspaceRoot and verifies containment.
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  subPath: string,
  allowedRoots?: string[]
): string {
  const resolved = path.isAbsolute(subPath)
    ? normalizePath(subPath)
    : normalizePath(path.join(workspaceRoot, subPath));

  // Contain within workspace root
  if (!isPathContained(resolved, workspaceRoot)) {
    throw new Error(`Path "${subPath}" escapes workspace root "${workspaceRoot}".`);
  }

  if (allowedRoots && allowedRoots.length > 0) {
    assertPathWithinRoots(resolved, allowedRoots);
  }

  return resolved;
}
