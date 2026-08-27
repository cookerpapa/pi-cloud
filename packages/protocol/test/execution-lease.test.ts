import { describe, expect, it } from "vitest";
import {
  createExecutionLease,
  parseExecutionLease,
  parseSupervisorToControlMessage,
} from "../src/index.ts";

const LEASE_ID = "10000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "20000000-0000-4000-8000-000000000002";

describe("ExecutionLease", () => {
  it("round-trips the authority-issued identity at the minimum encoded length", () => {
    const token = createExecutionLease(LEASE_ID, ATTEMPT_ID, 1);

    expect(token).toHaveLength(73);
    expect(parseExecutionLease(token)).toEqual({
      leaseId: LEASE_ID,
      attemptId: ATTEMPT_ID,
      fencingToken: 1,
    });
  });

  it("rejects malformed and non-positive generations", () => {
    expect(() => createExecutionLease(LEASE_ID, ATTEMPT_ID, 0)).toThrow();
    expect(() => parseExecutionLease("pcel1_invalid")).toThrow();
  });

  it("is the only execution authority carried by an Agent event", () => {
    const executionLease = createExecutionLease(LEASE_ID, ATTEMPT_ID, 42);
    const message = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: "30000000-0000-4000-8000-000000000003",
      sentAt: "2026-08-25T00:00:00.000Z",
      type: "event.publish",
      payload: {
        executionLease,
        event: {
          schemaVersion: 1,
          eventId: "40000000-0000-4000-8000-000000000004",
          sessionId: "session-execution-lease",
          turnId: "turn-execution-lease",
          agentId: "root",
          seq: 1,
          occurredAt: "2026-08-25T00:00:00.000Z",
          type: "turn.started",
          payload: { inputKind: "prompt" },
        },
      },
    });
    if (message.type !== "event.publish") throw new Error("Expected Agent event publication");

    expect(message.payload).toEqual({ executionLease, event: message.payload.event });
    expect(message.payload).not.toHaveProperty("attemptId");
    expect(message.payload).not.toHaveProperty("leaseId");
    expect(message.payload).not.toHaveProperty("fencingToken");
  });
});
