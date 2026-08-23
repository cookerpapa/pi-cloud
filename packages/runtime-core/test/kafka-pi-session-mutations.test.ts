import { describe, expect, it } from "vitest";
import { parseKafkaPiSessionMutationEnvelope } from "../src/kafka-pi-session-mutations.ts";

const scope = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  sessionId: "session-projection-barrier",
  turnId: "10000000-0000-4000-8000-000000000002",
  runId: "10000000-0000-4000-8000-000000000003",
  attemptId: "10000000-0000-4000-8000-000000000004",
  claimOwnerId: "postgres:worker:boot",
  fencingToken: 7,
} as const;

describe("Kafka Pi Session mutation protocol", () => {
  it("accepts a Session-keyed projection barrier without inventing a Pi entry", () => {
    const barrier = parseKafkaPiSessionMutationEnvelope(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          mutationId: "10000000-0000-4000-8000-000000000005",
          scope,
          operation: { kind: "projection_barrier" },
          occurredAt: "2026-08-23T00:00:00.000Z",
        }),
      ),
    );

    expect(barrier.scope).toEqual(scope);
    expect(barrier.operation).toEqual({ kind: "projection_barrier" });
  });

  it("rejects an unscoped barrier", () => {
    expect(() =>
      parseKafkaPiSessionMutationEnvelope(
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            mutationId: "10000000-0000-4000-8000-000000000005",
            scope: { ...scope, sessionId: "" },
            operation: { kind: "projection_barrier" },
            occurredAt: "2026-08-23T00:00:00.000Z",
          }),
        ),
      ),
    ).toThrow("Session ID is invalid");
  });
});
