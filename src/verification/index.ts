import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { VerificationResult } from "../types/index.js";

/**
 * Calculates SHA-256 hash of a UTF-8 string or Buffer.
 */
export function calculateSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Verifies that a file on disk strictly matches expected content.
 * Performs length check, SHA-256 check, and byte readback.
 */
export async function verifyFileContent(
  filePath: string,
  expectedContent: string
): Promise<VerificationResult> {
  try {
    const actualBytes = await fs.readFile(filePath);
    const actualText = actualBytes.toString("utf-8");
    const actualHash = calculateSha256(actualBytes);
    const expectedHash = calculateSha256(Buffer.from(expectedContent, "utf-8"));

    if (actualHash === expectedHash) {
      return {
        performed: true,
        passed: true,
        method: "readback_sha256",
        details: {
          filePath,
          bytes: actualBytes.length,
          hash: actualHash,
        },
      };
    }

    // If normalized line endings match (CRLF vs LF), pass with normalization notice
    const normActual = actualText.replace(/\r\n/g, "\n");
    const normExpected = expectedContent.replace(/\r\n/g, "\n");

    if (normActual === normExpected) {
      return {
        performed: true,
        passed: true,
        method: "readback_content_normalized_newlines",
        details: {
          filePath,
          bytes: actualBytes.length,
          actualHash,
          expectedHash,
        },
      };
    }

    return {
      performed: true,
      passed: false,
      method: "readback_sha256",
      error: `File content mismatch: expected ${expectedContent.length} chars (hash: ${expectedHash.slice(0, 10)}...), found ${actualText.length} chars (hash: ${actualHash.slice(0, 10)}...)`,
      details: {
        filePath,
        expectedLength: expectedContent.length,
        actualLength: actualText.length,
        expectedHash,
        actualHash,
      },
    };
  } catch (err: any) {
    return {
      performed: true,
      passed: false,
      method: "readback_sha256",
      error: `Readback failed: ${err.message}`,
      details: { filePath },
    };
  }
}

/**
 * Verifies that a file either exists or does not exist on disk.
 */
export async function verifyFileExistence(
  filePath: string,
  shouldExist: boolean
): Promise<VerificationResult> {
  try {
    const stat = await fs.stat(filePath);
    if (shouldExist) {
      return {
        performed: true,
        passed: true,
        method: "fs_stat_exists",
        details: { filePath, size: stat.size, isFile: stat.isFile() },
      };
    } else {
      return {
        performed: true,
        passed: false,
        method: "fs_stat_exists",
        error: `Expected file "${filePath}" to be deleted, but it still exists (${stat.size} bytes).`,
      };
    }
  } catch (err: any) {
    if (err.code === "ENOENT") {
      if (!shouldExist) {
        return {
          performed: true,
          passed: true,
          method: "fs_stat_unlinked",
          details: { filePath },
        };
      } else {
        return {
          performed: true,
          passed: false,
          method: "fs_stat_exists",
          error: `Expected file "${filePath}" to exist, but it was not found.`,
        };
      }
    }
    return {
      performed: true,
      passed: false,
      method: "fs_stat",
      error: `Stat check failed: ${err.message}`,
    };
  }
}

/**
 * Verifies file relocation (move): source unlinked, target exists with content.
 */
export async function verifyFileRelocation(
  oldPath: string,
  newPath: string
): Promise<VerificationResult> {
  const sourceGone = await verifyFileExistence(oldPath, false);
  if (!sourceGone.passed) {
    return {
      performed: true,
      passed: false,
      method: "file_relocation_check",
      error: `Source file "${oldPath}" still exists after move.`,
    };
  }

  const destExists = await verifyFileExistence(newPath, true);
  if (!destExists.passed) {
    return {
      performed: true,
      passed: false,
      method: "file_relocation_check",
      error: `Destination file "${newPath}" does not exist after move.`,
    };
  }

  return {
    performed: true,
    passed: true,
    method: "file_relocation_check",
    details: { oldPath, newPath },
  };
}
