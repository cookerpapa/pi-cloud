import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactChannelPiSessionMutationProducer } from "../src/fact-channel-pi-session-mutation-producer.ts";
import type { CandidatePiSessionMutationFact } from "../src/accepted-fact.ts";

afterEach(() => vi.useRealTimers());
const scope = {
  tenantId: "tenant",
  sessionId: "session",
  piSessionId: "session",
  piSessionLane: "main",
  turnId: "turn",
  runId: "run",
  executionLease: "lease",
};
function fixture() {
  const publications: CandidatePiSessionMutationFact[] = [];
  const rows: Record<string, unknown>[] = [];
  const reads = vi.fn(async () => [...rows]);
  const query = {
    select() {
      return this;
    },
    where() {
      return this;
    },
    execute: reads,
  };
  const producer = new FactChannelPiSessionMutationProducer({
    database: { selectFrom: () => query } as unknown as Kysely<Database>,
    channels: {
      async checkHealth() {},
      resolve: () => ({
        async mutate(request) {
          publications.push(request);
          return { mutationId: request.mutationId, accepted: true };
        },
      }),
    },
  });
  const complete = (request: CandidatePiSessionMutationFact) =>
    rows.push({
      mutation_id: request.mutationId,
      tenant_id: scope.tenantId,
      session_id: scope.sessionId,
      state: "completed",
      result: { ok: true },
    });
  return { producer, publications, reads, complete };
}

describe("shared Pi projection receipts", () => {
  it("publishes first and coalesces concurrent receipt reads without per-mutation polling", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = Array.from({ length: 100 }, () => f.producer.scoped(scope).synchronize());
    expect(f.publications).toHaveLength(100);
    expect(f.reads).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.reads).toHaveBeenCalledTimes(1);
    for (const request of f.publications) {
      f.complete(request);
      f.producer.notifyProjected(request.mutationId);
    }
    await Promise.all(pending);
    expect(f.reads).toHaveBeenCalledTimes(2);
    await f.producer.close();
  });
  it("checks durable rows after a lost notification and never treats a wakeup as success", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let settled = false;
    const pending = f.producer
      .scoped(scope)
      .synchronize()
      .then(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(0);
    f.producer.notifyProjected(f.publications[0]!.mutationId);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    f.complete(f.publications[0]!);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(settled).toBe(true);
    await f.producer.close();
  });
});
