import { describe, expect, it } from "vitest";
import { maximumRunOverlap, runStageTiming } from "./live-run-timing.mjs";

describe("live acceptance timing boundaries", () => {
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
