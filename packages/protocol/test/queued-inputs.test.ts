import { describe, it, expect } from "vitest";
import {
  parseInputQueueResource,
  parseQueuedInputAction,
  parseTurnSteerResource,
  parseResumeInputQueue,
} from "../src/index.ts";
const id = "10000000-0000-4000-8000-000000000001";
describe("pending input protocol", () => {
  it("represents durable Steer acceptance separately from delivery and consumption", () => {
    const accepted = {
      controlRequestId: id,
      targetRunId: id,
      targetTurnId: id,
      sourceRunId: id,
      sourceTurnId: id,
      sessionId: id,
      state: "accepted",
      acceptedAt: "2026-09-30T00:00:00.000Z",
      replayed: false,
    };
    expect(parseTurnSteerResource(accepted)).toEqual(accepted);
    expect(() =>
      parseTurnSteerResource({ ...accepted, state: "delivered", deliveredAt: accepted.acceptedAt }),
    ).toThrow();
    expect(() => parseTurnSteerResource({ ...accepted, sourceTurnId: undefined })).toThrow();
  });
  it("accepts atomic edited steer and requires an explicit target and revision", () => {
    expect(parseQueuedInputAction({ action: "send", revision: 4 })).toEqual({
      action: "send",
      revision: 4,
    });
    expect(parseResumeInputQueue({ revision: 4 })).toEqual({ revision: 4 });
    expect(() => parseResumeInputQueue({})).toThrow();
    expect(
      parseQueuedInputAction({ action: "steer", revision: 4, targetTurnId: id, text: "updated" }),
    ).toMatchObject({ text: "updated" });
    // Existing attachments are resolved under the queue lock, so an empty
    // caption is valid at the wire boundary.
    expect(parseQueuedInputAction({ action: "edit", revision: 4, text: "" })).toMatchObject({
      text: "",
    });
    for (const value of [
      { action: "steer", revision: 4 },
      { action: "cancel", revision: -1 },
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
      paused: true,
    };
    const queue = {
      sessionId: id,
      revision: 0,
      viewVersion: "0",
      afterPosition: 0,
      hasMore: false,
      activeTurnId: null,
      hasPausedInputs: true,
      items: [item],
    };
    expect(parseInputQueueResource(queue).items[0]?.status).toBe("steering");
    expect(() =>
      parseInputQueueResource({ ...queue, items: Array.from({ length: 21 }, () => item) }),
    ).toThrow();
    expect(
      parseInputQueueResource({
        ...queue,
        hasMore: true,
        items: Array.from({ length: 20 }, () => item),
      }).items,
    ).toHaveLength(20);
  });
});
