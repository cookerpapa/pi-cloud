import { describe, it, expect } from "vitest";
import {
  parseInputQueueResource,
  parseQueuedInputAction,
  parseAcceptedConversationInputResource,
  parseAcknowledgeReturnedInputs,
  parseReturnedInputsResource,
} from "../src/index.ts";
const id = "10000000-0000-4000-8000-000000000001";
describe("pending input protocol", () => {
  it("represents durable Steer acceptance separately from delivery and consumption", () => {
    const accepted = {
      kind: "input",
      inputId: "input-" + "a".repeat(64),
      turnId: id,
      runId: id,
      delivery: "steer",
      sessionId: id,
      state: "accepted",
      acceptedAt: "2026-09-30T00:00:00.000Z",
      replayed: false,
    };
    expect(parseAcceptedConversationInputResource(accepted)).toEqual(accepted);
    expect(() =>
      parseAcceptedConversationInputResource({
        ...accepted,
        state: "delivered",
        deliveredAt: accepted.acceptedAt,
      }),
    ).toThrow();
    expect(() =>
      parseAcceptedConversationInputResource({ ...accepted, inputId: undefined }),
    ).toThrow();
  });
  it("accepts atomic edited steer and requires an explicit queue revision", () => {
    expect(() =>
      parseQueuedInputAction({ action: "send", revision: `${"a".repeat(64)}.${"b".repeat(64)}` }),
    ).toThrow();
    expect(parseAcknowledgeReturnedInputs({ requestId: id })).toEqual({ requestId: id });
    expect(() => parseAcknowledgeReturnedInputs({ requestId: id, turnIds: [id] })).toThrow();
    expect(() => parseAcknowledgeReturnedInputs({})).toThrow();
    expect(
      parseReturnedInputsResource({
        sessionId: id,
        requestId: id,
        afterPosition: 0,
        pending: true,
        hasMore: false,
        items: [],
      }).pending,
    ).toBe(true);
    expect(
      parseQueuedInputAction({
        action: "steer",
        revision: `${"a".repeat(64)}.${"b".repeat(64)}`,
        text: "updated",
      }),
    ).toMatchObject({ text: "updated" });
    // Existing attachments are resolved under the queue lock, so an empty
    // caption is valid at the wire boundary.
    expect(
      parseQueuedInputAction({
        action: "edit",
        revision: `${"a".repeat(64)}.${"b".repeat(64)}`,
        text: "",
      }),
    ).toMatchObject({
      text: "",
    });
    for (const value of [
      { action: "steer", revision: `${"a".repeat(64)}.${"b".repeat(64)}`, targetTurnId: id },
      { action: "cancel", revision: -1 },
      { action: "cancel", revision: `${"a".repeat(64)}.${"b".repeat(64)}`, runId: id },
      { action: "move", revision: `${"a".repeat(64)}.${"b".repeat(64)}`, direction: "first" },
    ])
      expect(() => parseQueuedInputAction(value)).toThrow();
  });

  it("requires the original admission identity for returned input", () => {
    const input = {
      inputId: id,
      idempotencyKey: "accepted-input",
      text: "draft",
      uploads: [],
      mailboxPosition: 2,
    };
    const page = {
      sessionId: id,
      requestId: id,
      afterPosition: 0,
      pending: false,
      hasMore: false,
      items: [input],
    };
    expect(parseReturnedInputsResource(page).items[0]?.idempotencyKey).toBe("accepted-input");
    expect(() =>
      parseReturnedInputsResource({ ...page, items: [{ ...input, idempotencyKey: undefined }] }),
    ).toThrow();
  });
  it("bounds queue snapshots and represents a promotion separately from runnable input", () => {
    const item = {
      inputId: id,
      runId: id,
      text: "pending",
      mailboxPosition: 1,
      acceptedAt: "2026-09-26T00:00:00.000Z",
      status: "steering",
    };
    const queue = {
      sessionId: id,
      revision: `${"a".repeat(64)}.${"b".repeat(64)}`,
      viewVersion: "0",
      afterPosition: 0,
      hasMore: false,
      activeTurnId: null,
      hasReturnedInputs: true,
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
