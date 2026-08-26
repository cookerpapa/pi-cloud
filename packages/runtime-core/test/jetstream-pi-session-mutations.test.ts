import { describe, expect, it } from "vitest";
import { parseAcceptedPiSessionMutationEnvelope } from "../src/jetstream-pi-session-mutations.ts";
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
} as const;

describe("JetStream Pi Session mutation protocol", () => {
  it("parses an accepted mutation without carrying ExecutionGrant authority downstream", () => {
    const accepted = parseAcceptedPiSessionMutationEnvelope(
      JSON.stringify({
        schemaVersion: 2,
        mutationId: "10000000-0000-4000-8000-000000000005",
        scope: {
          tenantId: scope.tenantId,
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          runId: scope.runId,
          executionId: "10000000-0000-4000-8000-000000000004",
        },
        operation: { kind: "projection_barrier" },
        occurredAt: "2026-08-23T00:00:00.000Z",
      }),
    );
    expect(accepted.scope).not.toHaveProperty("executionGrant");
    expect(accepted.scope.executionId).toBe("10000000-0000-4000-8000-000000000004");
  });

  it("maps one opaque Session consistently without exposing it as a NATS token", () => {
    const event = agentEventSubject(scope.sessionId);
    const live = agentLiveSubject(scope.sessionId);
    const mutation = piSessionMutationSubject(scope.sessionId);
    expect(event).toMatch(/^pi\.events\.[0-9a-f]{64}$/u);
    expect(live.slice("pi.live.".length)).toBe(event.slice("pi.events.".length));
    expect(mutation.slice("pi.session-mutations-v2.".length)).toBe(
      event.slice("pi.events.".length),
    );
    expect(event).not.toContain(scope.sessionId);
  });
});
