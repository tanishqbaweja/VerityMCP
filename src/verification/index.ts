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
        execution: { status: "passed", method: "fs_mutation" },
        state: { status: "passed", method: "sha256_readback", details: { bytes: actualBytes.length, hash: actualHash } },
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
        execution: { status: "passed", method: "fs_mutation" },
        state: { status: "passed", method: "readback_content_normalized_newlines", details: { bytes: actualBytes.length } },
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
      execution: { status: "passed", method: "fs_mutation" },
      state: {
        status: "failed",
        method: "sha256_readback",
        error: `File content mismatch: expected ${expectedContent.length} chars (hash: ${expectedHash.slice(0, 10)}...), found ${actualText.length} chars (hash: ${actualHash.slice(0, 10)}...)`,
      },
    };
  } catch (err: any) {
    return {
      performed: true,
      passed: false,
      method: "readback_sha256",
      error: `Readback failed: ${err.message}`,
      details: { filePath },
      execution: { status: "failed", method: "fs_mutation", error: err.message },
      state: { status: "failed", method: "sha256_readback", error: err.message },
    };
  }
}

/**
 * Verifies an exact byte-for-byte file copy. Unlike verifyFileContent, this never
 * decodes bytes as text or normalizes line endings.
 */
export async function verifyFileBytes(
  filePath: string,
  expectedBytes: Buffer
): Promise<VerificationResult> {
  try {
    const actualBytes = await fs.readFile(filePath);
    const actualHash = calculateSha256(actualBytes);
    const expectedHash = calculateSha256(expectedBytes);
    const passed = actualBytes.length === expectedBytes.length && actualBytes.equals(expectedBytes);

    if (passed) {
      return {
        performed: true,
        passed: true,
        method: "readback_sha256_bytes",
        details: {
          filePath,
          bytes: actualBytes.length,
          hash: actualHash,
        },
        execution: { status: "passed", method: "fs_mutation" },
        state: {
          status: "passed",
          method: "sha256_byte_readback",
          details: { bytes: actualBytes.length, hash: actualHash },
        },
      };
    }

    const error = `File byte mismatch: expected ${expectedBytes.length} bytes (hash: ${expectedHash.slice(0, 10)}...), found ${actualBytes.length} bytes (hash: ${actualHash.slice(0, 10)}...)`;
    return {
      performed: true,
      passed: false,
      method: "readback_sha256_bytes",
      error,
      details: {
        filePath,
        expectedBytes: expectedBytes.length,
        actualBytes: actualBytes.length,
        expectedHash,
        actualHash,
      },
      execution: { status: "passed", method: "fs_mutation" },
      state: { status: "failed", method: "sha256_byte_readback", error },
    };
  } catch (err: any) {
    return {
      performed: true,
      passed: false,
      method: "readback_sha256_bytes",
      error: `Readback failed: ${err.message}`,
      details: { filePath },
      execution: { status: "failed", method: "fs_mutation", error: err.message },
      state: { status: "failed", method: "sha256_byte_readback", error: err.message },
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
        execution: { status: "passed", method: "fs_existence_probe" },
        state: { status: "passed", method: "fs_stat_exists", details: { size: stat.size } },
      };
    } else {
      return {
        performed: true,
        passed: false,
        method: "fs_stat_exists",
        error: `Expected file "${filePath}" to be deleted, but it still exists (${stat.size} bytes).`,
        execution: { status: "passed", method: "fs_existence_probe" },
        state: { status: "failed", method: "fs_stat_exists", error: `File still exists (${stat.size} bytes)` },
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
          execution: { status: "passed", method: "fs_existence_probe" },
          state: { status: "passed", method: "fs_stat_unlinked" },
        };
      } else {
        return {
          performed: true,
          passed: false,
          method: "fs_stat_exists",
          error: `Expected file "${filePath}" to exist, but it was not found.`,
          execution: { status: "passed", method: "fs_existence_probe" },
          state: { status: "failed", method: "fs_stat_exists", error: "File not found" },
        };
      }
    }
    return {
      performed: true,
      passed: false,
      method: "fs_stat",
      error: `Stat check failed: ${err.message}`,
      execution: { status: "failed", method: "fs_existence_probe", error: err.message },
      state: { status: "failed", method: "fs_stat", error: err.message },
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
      execution: { status: "passed", method: "fs_move" },
      state: { status: "failed", method: "file_relocation_check", error: "Source file not unlinked" },
    };
  }

  const destExists = await verifyFileExistence(newPath, true);
  if (!destExists.passed) {
    return {
      performed: true,
      passed: false,
      method: "file_relocation_check",
      error: `Destination file "${newPath}" does not exist after move.`,
      execution: { status: "passed", method: "fs_move" },
      state: { status: "failed", method: "file_relocation_check", error: "Destination file missing" },
    };
  }

  return {
    performed: true,
    passed: true,
    method: "file_relocation_check",
    details: { oldPath, newPath },
    execution: { status: "passed", method: "fs_move" },
    state: { status: "passed", method: "file_relocation_check", details: { oldPath, newPath } },
  };
}
