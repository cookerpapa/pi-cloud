import { describe, expect, it, vi } from "vitest";
import { createExecutionGrant } from "@pi-cloud/protocol";
import {
  JetStreamPiSessionMutationIngestor,
  parseAcceptedPiSessionMutationEnvelope,
  parsePiSessionMutationRequest,
  type AcceptedPiSessionMutationEnvelope,
  type PiSessionMutationRequest,
} from "../src/jetstream-pi-session-mutations.ts";
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
  executionGrant: createExecutionGrant(
    "10000000-0000-4000-8000-000000000006",
    "10000000-0000-4000-8000-000000000004",
    7,
  ),
} as const;

describe("JetStream Pi Session mutation protocol", () => {
  it("accepts a Session-keyed projection barrier without inventing a Pi entry", () => {
    const barrier = parsePiSessionMutationRequest(
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
      parsePiSessionMutationRequest(
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

describe("JetStreamPiSessionMutationIngestor", () => {
  const request = (index: number): PiSessionMutationRequest => ({
    schemaVersion: 1,
    mutationId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    scope,
    operation: { kind: "set_name", name: `Session ${String(index)}` },
    occurredAt: "2026-08-23T00:00:00.000Z",
  });

  it("batches authority acceptance and publishes only grant-free envelopes", async () => {
    const requests = Array.from({ length: 64 }, (_, index) => request(index + 10));
    const appendGroup = vi.fn(
      async (_envelopes: readonly AcceptedPiSessionMutationEnvelope[]) => undefined,
    );
    const commitAcceptedMany = vi.fn(
      async (
        input: readonly PiSessionMutationRequest[],
        durableCommit: (accepted: readonly AcceptedPiSessionMutationEnvelope[]) => Promise<void>,
      ) => {
        const accepted = input.map((entry) => ({
          schemaVersion: 2 as const,
          mutationId: entry.mutationId,
          scope: {
            tenantId: entry.scope.tenantId,
            sessionId: entry.scope.sessionId,
            turnId: entry.scope.turnId,
            runId: entry.scope.runId,
            executionId: "10000000-0000-4000-8000-000000000004",
          },
          operation: entry.operation,
          occurredAt: entry.occurredAt,
        }));
        await durableCommit(accepted);
        return { accepted, rejected: [] };
      },
    );
    const ingestor = new JetStreamPiSessionMutationIngestor({
      authority: { commitAcceptedMany },
      publisher: { appendGroup, checkHealth: async () => undefined },
    });
    await Promise.all(requests.map((entry) => ingestor.ingest(entry)));
    expect(commitAcceptedMany).toHaveBeenCalledTimes(1);
    expect(appendGroup).toHaveBeenCalledTimes(1);
    expect(appendGroup.mock.calls[0]![0]).toHaveLength(64);
    expect(JSON.stringify(appendGroup.mock.calls[0]![0])).not.toContain("executionGrant");
    await ingestor.close();
  });

  it("rejects a stale mutation before durable publication", async () => {
    const stale = request(100);
    const appendGroup = vi.fn(
      async (_envelopes: readonly AcceptedPiSessionMutationEnvelope[]) => undefined,
    );
    const ingestor = new JetStreamPiSessionMutationIngestor({
      authority: {
        commitAcceptedMany: async () => ({ accepted: [], rejected: [stale] }),
      },
      publisher: { appendGroup, checkHealth: async () => undefined },
    });
    await expect(ingestor.ingest(stale)).rejects.toMatchObject({
      code: "stale_execution_grant",
    });
    expect(appendGroup).not.toHaveBeenCalled();
    await ingestor.close();
  });
});
