import { describe, expect, it } from "vitest";
import { parseJetStreamPiSessionMutationEnvelope } from "../src/jetstream-pi-session-mutations.ts";
import {
  agentEventSubject,
  agentLiveSubject,
  piSessionMutationSubject,
} from "../src/jetstream-runtime.ts";

const scope = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  sessionId: "session-projection-barrier",
  turnId: "10000000-0000-4000-8000-000000000002",
  runId: "10000000-0000-4000-8000-000000000003",
  attemptId: "10000000-0000-4000-8000-000000000004",
  claimOwnerId: "postgres:worker:boot",
  fencingToken: 7,
} as const;

describe("JetStream Pi Session mutation protocol", () => {
  it("accepts a Session-keyed projection barrier without inventing a Pi entry", () => {
    const barrier = parseJetStreamPiSessionMutationEnvelope(
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
      parseJetStreamPiSessionMutationEnvelope(
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

  it("maps one opaque Session consistently without exposing it as a NATS token", () => {
    const event = agentEventSubject(scope.sessionId);
    const live = agentLiveSubject(scope.sessionId);
    const mutation = piSessionMutationSubject(scope.sessionId);
    expect(event).toMatch(/^pi\.events\.[0-9a-f]{64}$/u);
    expect(live.slice("pi.live.".length)).toBe(event.slice("pi.events.".length));
    expect(mutation.slice("pi.session-mutations.".length)).toBe(event.slice("pi.events.".length));
    expect(event).not.toContain(scope.sessionId);
  });
});
