import { describe, expect, it } from "vitest";
import {
  isDurableAgentActivity,
  localWorkerTargets,
  maximumRunOverlap,
  readWorkerModelTimings,
  runStageTiming,
} from "./live-run-timing.mjs";

describe("deployed Worker timing inventory", () => {
  const line = (runId, receivedAtMs) =>
    JSON.stringify({
      timestamp: "2026-09-17T00:00:00Z",
      event: "model.transport.timing",
      attributes: { runId, receivedAtMs },
    });
  it("reads only actual Compose Workers and filters other Run records", async () => {
    const calls = [];
    const records = await readWorkerModelTimings(["mine"], 2000, {
      deployment: "compose",
      execute: async (binary, args) => {
        calls.push([binary, args]);
        if (args[0] === "ps")
          return {
            stdout:
              "pi-cloud-production-supervisor-host-1 worker:one\n" +
              "pi-cloud-production-control-plane-1 cp:one\n" +
              "pi-cloud-production-supervisor-host-2-1 worker:two\n",
          };
        return {
          stdout: line("other", 1) + "\n" + line("mine", args[1].includes("-2-1") ? 2 : 3),
          stderr: "diagnostic only",
        };
      },
    });
    expect(records).toEqual([
      { runId: "mine", receivedAtMs: 2 },
      { runId: "mine", receivedAtMs: 3 },
    ]);
    expect(calls).toHaveLength(3);
    expect(calls.every(([binary]) => binary === "docker")).toBe(true);
    expect(calls[1][1].slice(-2)).toEqual(["--since", "1970-01-01T00:00:01.000Z"]);
  });
  it("reads current and terminated Kubernetes containers without guessing a Compose name", async () => {
    const calls = [];
    const records = await readWorkerModelTimings(["mine"], 2000, {
      deployment: "kubernetes",
      runtimeDirectory: "/fixture",
      execute: async (binary, args) => {
        calls.push([binary, args]);
        if (args.includes("get"))
          return {
            stdout: JSON.stringify({
              items: [
                {
                  metadata: { name: "worker-v1-0" },
                  spec: { containers: [{ name: "pi-worker", image: "worker:git-sha" }] },
                  status: { containerStatuses: [{ name: "pi-worker", restartCount: 1 }] },
                },
              ],
            }),
          };
        return {
          stdout: line("mine", args.includes("--previous") ? 1 : 2),
          stderr: "",
        };
      },
    });
    expect(records.map((record) => record.receivedAtMs)).toEqual([1, 2]);
    expect(calls).toHaveLength(3);
    expect(calls.every(([binary]) => binary === "kubectl")).toBe(true);
    expect(calls[1][1]).toContain("--since-time");
    expect(calls[2][1]).toContain("--previous");
    expect(calls[0][1].slice(0, 4)).toEqual([
      "--kubeconfig",
      "/fixture/kubernetes/pi-worker-local.kubeconfig",
      "--namespace",
      "pi-cloud-workers",
    ]);
  });
  it("propagates inventory failure instead of producing empty timing evidence", async () => {
    await expect(
      localWorkerTargets({
        deployment: "kubernetes",
        execute: async () => {
          throw new Error("cluster unreachable");
        },
      }),
    ).rejects.toThrow("cluster unreachable");
    await expect(localWorkerTargets({ deployment: "unsupported" })).rejects.toThrow("Unsupported");
  });
});

describe("live acceptance timing boundaries", () => {
  it("uses the current public Tool preparation and hosted-search event names", () => {
    for (const type of [
      "assistant.text.delta",
      "assistant.tool_call.preparing",
      "tool.started",
      "provider.hosted_tool.started",
    ])
      expect(isDurableAgentActivity({ type })).toBe(true);
    for (const type of ["tool.preparing", "turn.started", "assistant.thinking.delta"])
      expect(isDurableAgentActivity({ type })).toBe(false);
  });
  it("refuses a clock-stepped cross-process decomposition", () => {
    expect(
      runStageTiming(
        {
          submittedWallAt: 1000,
          firstAssistantTextMs: 650,
          firstAssistantTextEmittedAtMs: 4600,
          firstAssistantTextReceivedAtMs: 4650,
        },
        [{ receivedAtMs: 4100, upstreamStartMs: 10, firstTextMs: 480 }],
      ),
    ).toEqual({
      unavailable:
        "Host wall clock changed during the Run; validate the monotonic clock independently before using durations",
      clockStepMs: 3000,
    });
  });
  it("subtracts only the matched request-to-first-text interval, not full streaming duration", () => {
    expect(
      runStageTiming(
        { submittedWallAt: 1000, firstAssistantTextMs: 650, firstAssistantTextEmittedAtMs: 1600 },
        [{ receivedAtMs: 1100, upstreamStartMs: 10, firstTextMs: 480, elapsedMs: 9000 }],
      ),
    ).toMatchObject({
      firstModelDispatchMs: 110,
      providerRouteToFirstTextMs: 470,
      parsedTextToPiEventMs: 20,
      piEventToClientTextMs: 50,
      nonProviderTtftMs: 180,
    });
  });
  it("does not claim preceding Tool/model work is transport overhead for a tool-first Run", () => {
    const timing = runStageTiming(
      { submittedWallAt: 1000, firstAssistantTextMs: 2600, firstAssistantTextEmittedAtMs: 3500 },
      [
        { receivedAtMs: 1100, upstreamStartMs: 10, firstToolMs: 300, elapsedMs: 1000 },
        { receivedAtMs: 2500, upstreamStartMs: 20, firstTextMs: 950, elapsedMs: 2000 },
      ],
    );
    expect(timing.firstTextFollowsEarlierSampling).toBe(true);
    expect(timing.nonProviderTtftMs).toBeUndefined();
    expect(
      runStageTiming({ submittedWallAt: 1000, firstAssistantTextMs: 2600 }, []),
    ).toBeUndefined();
  });
  it("measures Run overlap with end-before-start ties", () => {
    expect(
      maximumRunOverlap([
        { queuedWallAt: 1000, queueWaitMs: 0, serverElapsedMs: 100 },
        { queuedWallAt: 1000, queueWaitMs: 50, serverElapsedMs: 150 },
        { queuedWallAt: 1000, queueWaitMs: 100, serverElapsedMs: 200 },
      ]),
    ).toBe(2);
  });
});
