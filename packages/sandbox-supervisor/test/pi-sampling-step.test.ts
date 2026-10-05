import { describe, expect, it } from "vitest";
import { DurableSampling } from "../src/durable/sampling.ts";

function capture(sequence: number) {
  return {
    step: {
      context: {
        schemaVersion: 2 as const,
        sequence,
        turnContextSha256: "a".repeat(64),
        executionContextSha256: "b".repeat(64),
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

describe("native checkpoint sampling identity", () => {
  it("shares one captured world within a checkpoint and reads attempts from native state", async () => {
    const sampling = new DurableSampling();
    sampling.select({ sequence: 42, attempt: 2, publish: true });
    const first = await sampling.capture(async (sequence) => capture(sequence));
    const same = await sampling.capture(async () => {
      throw new Error("Capture must be shared");
    });
    expect(first).toEqual(same);
    expect(first.samplingAttempt).toBe(2);
    expect(first.step.context.sequence).toBe(42);
    sampling.select({ sequence: 53, attempt: 3, publish: true });
    expect(
      (await sampling.capture(async (sequence) => capture(sequence))).step.context.sequence,
    ).toBe(53);
  });
  it("requires a native boundary and keeps recovery preparation out of model-start events", async () => {
    const sampling = new DurableSampling();
    await expect(sampling.capture(async () => capture(1))).rejects.toThrow(
      "no admitted native checkpoint",
    );
    expect(() => sampling.select({ sequence: 0, attempt: 1, publish: true })).toThrow();
    sampling.select({ sequence: 7, attempt: 1, publish: false });
    expect(sampling.publish).toBe(false);
    expect(sampling.selected).toBe(true);
    expect(
      (await sampling.capture(async (sequence) => capture(sequence))).step.context.sequence,
    ).toBe(7);
  });
});
