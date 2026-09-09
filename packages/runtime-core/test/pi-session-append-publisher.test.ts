import { expect, it, vi } from "vitest";
import { NativeSessionLogPublisher } from "../src/native-session-log-publisher.ts";
import type { AcceptedFactWriter, CandidatePiSessionAppendFact } from "../src/accepted-fact.ts";

const scope = {
  tenantId: "tenant",
  sessionId: "product-session",
  piSessionId: "native-session",
  piSessionLane: "main",
  writerId: "writer",
  turnId: "turn",
  runId: "run",
  executionLease: "lease",
};
it("finishes at Kafka ACK without a PG client, receipt reader or polling", async () => {
  const publications: CandidatePiSessionAppendFact[] = [];
  const channel: AcceptedFactWriter = {
    publishToolCommand: async () => {
      throw new Error("unused");
    },
    mutate: async (request) => {
      publications.push(request);
      return { mutationId: request.mutationId, accepted: true };
    },
  };
  const publisher = new NativeSessionLogPublisher({
    channels: { resolve: () => channel, checkHealth: async () => {} },
  });
  await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      publisher.scoped(scope).publish([{ kind: "fact", fact: "name", name: "test", seq: i + 1 }]),
    ),
  );
  expect(publications).toHaveLength(100);
  expect(new Set(publications.map((p) => p.mutationId)).size).toBe(100);
  expect(publications[0]).toMatchObject({ scope, items: [{ kind: "fact", fact: "name", seq: 1 }] });
  await publisher.close();
  await expect(publisher.scoped(scope).publish([])).rejects.toThrow("closed");
});
it("does not acknowledge a failed or mismatched durable append", async () => {
  const mutate = vi
    .fn<AcceptedFactWriter["mutate"]>()
    .mockRejectedValueOnce(new Error("Kafka unavailable"))
    .mockResolvedValueOnce({ mutationId: "different", accepted: true });
  const channel: AcceptedFactWriter = {
    mutate,
    publishToolCommand: async () => {
      throw new Error("unused");
    },
  };
  const publisher = new NativeSessionLogPublisher({
    channels: { resolve: () => channel, checkHealth: async () => {} },
  });
  await expect(publisher.scoped(scope).publish([])).rejects.toThrow("Kafka unavailable");
  await expect(publisher.scoped(scope).publish([])).rejects.toThrow("identity changed");
  await publisher.close();
});
