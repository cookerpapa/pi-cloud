import { describe, expect, it } from "vitest";
import {
  createExecutionGrant,
  parseExecutionGrant,
  parseSupervisorToControlMessage,
} from "../src/index.ts";

const GRANT_ID = "10000000-0000-4000-8000-000000000001";
const EXECUTION_ID = "20000000-0000-4000-8000-000000000002";

describe("ExecutionGrant", () => {
  it("round-trips the authority-issued identity at the minimum encoded length", () => {
    const token = createExecutionGrant(GRANT_ID, EXECUTION_ID, 1);

    expect(token).toHaveLength(73);
    expect(parseExecutionGrant(token)).toEqual({
      grantId: GRANT_ID,
      executionId: EXECUTION_ID,
      generation: 1,
    });
  });

  it("rejects malformed and non-positive generations", () => {
    expect(() => createExecutionGrant(GRANT_ID, EXECUTION_ID, 0)).toThrow();
    expect(() => parseExecutionGrant("pceg1_invalid")).toThrow();
  });

  it("is the only execution authority carried by an Agent event", () => {
    const executionGrant = createExecutionGrant(GRANT_ID, EXECUTION_ID, 42);
    const message = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: "30000000-0000-4000-8000-000000000003",
      sentAt: "2026-08-25T00:00:00.000Z",
      type: "event.publish",
      payload: {
        executionGrant,
        event: {
          schemaVersion: 1,
          eventId: "40000000-0000-4000-8000-000000000004",
          sessionId: "session-execution-grant",
          turnId: "turn-execution-grant",
          agentId: "root",
          seq: 1,
          occurredAt: "2026-08-25T00:00:00.000Z",
          type: "turn.started",
          payload: { inputKind: "prompt" },
        },
      },
    });
    if (message.type !== "event.publish") throw new Error("Expected Agent event publication");

    expect(message.payload).toEqual({ executionGrant, event: message.payload.event });
    expect(message.payload).not.toHaveProperty("attemptId");
    expect(message.payload).not.toHaveProperty("leaseId");
    expect(message.payload).not.toHaveProperty("fencingToken");
  });
});
