import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PiCloudMetrics } from "@pi-cloud/observability";
import { ImageAttachmentCodec } from "@pi-cloud/session-attachments";
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
  executionReference: "lease",
};
it("excludes attachment upload from Kafka acknowledgement timing", async () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const metrics = new PiCloudMetrics("publisher-timing");
  const sample = vi.spyOn(metrics, "observeSessionMutation");
  const images = new ImageAttachmentCodec({
    async put(_scope, bytes, mimeType) {
      now += 100;
      return {
        id: crypto.randomUUID(),
        mimeType,
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
    async get() {
      throw new Error("unused");
    },
  });
  const publisher = new NativeSessionLogPublisher({
    images,
    metrics,
    channels: {
      checkHealth: async () => {},
      resolve: () => ({
        publishSubagentCommand: async () => {
          throw new Error("unused");
        },
        publishToolCommand: async () => {
          throw new Error("unused");
        },
        mutate: async (request) => {
          now += 7;
          return { mutationId: request.mutationId, accepted: true };
        },
      }),
    },
  });
  try {
    await publisher.scoped(scope).publish([
      {
        kind: "entry",
        lane: "main",
        turnId: null,
        entry: {
          id: "image",
          type: "message",
          seq: 1,
          timestamp: 1,
          parentId: null,
          message: {
            role: "user",
            content: [
              {
                type: "image",
                mimeType: "image/png",
                data: Buffer.from("image").toString("base64"),
              },
            ],
            timestamp: 1,
          },
        },
      },
    ]);
    expect(sample.mock.calls).toEqual([
      ["attachment_prepare", 100],
      ["kafka_publish", 7],
    ]);
  } finally {
    clock.mockRestore();
    await publisher.close();
  }
});

it("finishes at Kafka ACK without a PG client, receipt reader or polling", async () => {
  const publications: CandidatePiSessionAppendFact[] = [];
  const channel: AcceptedFactWriter = {
    publishSubagentCommand: async () => {
      throw new Error("unused");
    },
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
    publishSubagentCommand: async () => {
      throw new Error("unused");
    },
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
