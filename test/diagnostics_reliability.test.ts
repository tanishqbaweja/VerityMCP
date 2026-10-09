import { describe, it } from "node:test";
import assert from "node:assert";
import { ObservabilityManager } from "../src/observability/diagnostics.js";

describe("VerityMCP diagnostics reliability accounting", () => {
  it("reports N/A rather than synthetic 100% when there is no denominator", () => {
    const manager = new ObservabilityManager();
    const empty = manager.getDiagnostics();
    const emptyData = empty.data as any;

    assert.strictEqual(emptyData.reliability.executionSuccessRate, "N/A");
    assert.strictEqual(emptyData.reliability.verificationSuccessRate, "N/A");

    manager.logToolEvent({
      toolName: "guard",
      action: "guarded",
      success: false,
      durationMs: 1,
      timestamp: Date.now(),
      errorCode: "WORKTREE_DIRTY",
    });
    const guardedOnly = manager.getDiagnostics();
    const guardedData = guardedOnly.data as any;

    assert.strictEqual(guardedData.reliability.guarded_refusals, 1);
    assert.strictEqual(guardedData.reliability.executionSuccessRate, "N/A");
    assert.strictEqual(guardedData.reliability.verificationSuccessRate, "N/A");
  });

  it("measures real failure rates instead of masking them", () => {
    const manager = new ObservabilityManager();
    manager.logToolEvent({
      toolName: "failure",
      action: "failed",
      success: false,
      durationMs: 2,
      timestamp: Date.now(),
      errorCode: "COMMAND_FAILED",
    });

    const diagnostics = manager.getDiagnostics();
    const data = diagnostics.data as any;
    assert.strictEqual(data.reliability.operational_failures, 1);
    assert.strictEqual(data.reliability.executionSuccessRate, "0.0%");
    assert.strictEqual(data.reliability.verificationSuccessRate, "N/A");
  });
});
