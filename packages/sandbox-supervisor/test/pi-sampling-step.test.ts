import { describe, expect, it } from "vitest";
import { PiSamplingStepController } from "../src/pi-sampling-step.ts";

function capture(sequence: number) {
  return {
    step: {
      context: {
        schemaVersion: 2 as const,
        sequence,
        turnContextSha256: "a".repeat(64),
        attemptContextSha256: "b".repeat(64),
        activeTools: ["bash", "edit", "read", "write"],
        worldState: {
          sandbox: { status: "inactive" as const, continuitySha256: null },
          environmentSha256: "c".repeat(64),
          workspaceBindingSha256: "f".repeat(64),

          toolPolicySha256: "d".repeat(64),
        },
      },
      sha256: sequence.toString(16).padStart(64, "0"),
    },
    modelMessages: [],
  };
}

describe("PiSamplingStepController", () => {
  it("reuses the frozen Step only for the scheduled provider retry", async () => {
    const controller = new PiSamplingStepController();
    const first = await controller.captureAsync(async () => capture(1));
    controller.scheduleRetry(1);
    const retry = await controller.captureAsync(async () => capture(99));
    const next = await controller.captureAsync(async () => capture(2));

    expect(first.samplingAttempt).toBe(1);
    expect(retry).toMatchObject({
      step: { context: { sequence: 1 } },
      samplingAttempt: 2,
    });
    expect(next).toMatchObject({
      step: { context: { sequence: 2 } },
      samplingAttempt: 1,
    });
  });

  it("rejects retry and Step-order ambiguity", async () => {
    const controller = new PiSamplingStepController();
    expect(() => controller.scheduleRetry(1)).toThrow("without an active Cloud Step");
    await controller.captureAsync(async () => capture(2));
    await expect(controller.captureAsync(async () => capture(2))).rejects.toThrow(
      "did not advance",
    );
    controller.scheduleRetry(1);
    expect(() => controller.scheduleRetry(2)).toThrow("overlapping");
  });
});
