import { describe, it, expect } from "vitest";
import {
  MAX_QUEUED_INPUTS,
  parseInputQueueResource,
  parseQueuedInputAction,
} from "../src/index.ts";
const id = "10000000-0000-4000-8000-000000000001";
describe("pending input protocol", () => {
  it("accepts atomic edited steer and requires an explicit target and revision", () => {
    expect(
      parseQueuedInputAction({ action: "steer", revision: 4, targetTurnId: id, text: "updated" }),
    ).toMatchObject({ text: "updated" });
    for (const value of [
      { action: "steer", revision: 4 },
      { action: "cancel", revision: -1 },
      { action: "edit", revision: 4, text: "" },
      { action: "cancel", revision: 4, runId: id },
      { action: "move", revision: 4, direction: "first" },
    ])
      expect(() => parseQueuedInputAction(value)).toThrow();
  });
  it("bounds queue snapshots and represents a promotion separately from runnable input", () => {
    const item = {
      turnId: id,
      runId: id,
      text: "pending",
      mailboxPosition: 1,
      acceptedAt: "2026-09-26T00:00:00.000Z",
      status: "steering",
    };
    const queue = { sessionId: id, revision: 0, activeTurnId: null, items: [item] };
    expect(parseInputQueueResource(queue).items[0]?.status).toBe("steering");
    expect(() =>
      parseInputQueueResource({
        ...queue,
        items: Array.from({ length: MAX_QUEUED_INPUTS + 1 }, () => item),
      }),
    ).toThrow();
  });
});
