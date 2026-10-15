import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PiCloudMetrics } from "@pi-cloud/observability";
import { ImageAttachmentCodec } from "@pi-cloud/session-attachments";
import { DurableSessionPublisher } from "../src/durable-session-publisher.ts";
import type { AcceptedDurableCommitFact, AcceptedFactWriter } from "../src/accepted-fact.ts";
import { toolInvocationFixture } from "./tool-invocation-fixture.ts";

it("uploads images before Kafka timing, packs their references, and rejects publication after close", async () => {
  const { scope, executionReference } = toolInvocationFixture();
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const metrics = new PiCloudMetrics("publisher-timing"),
    sample = vi.spyOn(metrics, "observeSessionMutation");
  const data = Buffer.from("image").toString("base64");
  const images = new ImageAttachmentCodec({
    put: async (_scope, bytes, mimeType) => {
      now += 100;
      return {
        id: crypto.randomUUID(),
        mimeType,
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
    get: async () => {
      throw new Error("unused");
    },
  });
  let accepted: AcceptedDurableCommitFact | undefined;
  const channel: AcceptedFactWriter = {
    publication: { scope },

    commitNative: async (fact) => {
      now += 7;
      accepted = fact;
    },
  };
  const publisher = new DurableSessionPublisher({
    images,
    metrics,
    replyTopic: "reply-worker-boot",
    channels: { resolve: () => channel, checkHealth: async () => {} },
  });
  const publication = {
    commit: {
      seq: 1,
      nextId: 3,
      writes: [
        {
          type: "entry",
          value: {
            id: 2,
            conversationId: 1,
            kind: "pi.user",
            model: [
              {
                role: "user",
                content: [{ type: "image", mimeType: "image/png", data }],
                timestamp: 1,
              },
            ],
          },
        },
      ],
    },
    origins: [],
    inputQueueSessions: [scope.sessionId],
    tools: [],
    cancellations: [],
    display: [],
  };
  try {
    await publisher.scoped(executionReference).publish(publication);
    expect(sample.mock.calls).toEqual([
      ["attachment_prepare", 100],
      ["kafka_publish", 7],
    ]);
    expect(accepted?.inputQueueSessions).toEqual([scope.sessionId]);
    expect(JSON.stringify(accepted)).not.toContain(data);
    expect(JSON.stringify(accepted)).toContain("pi_cloud_image_v1");
    await publisher.close();
    await expect(publisher.scoped(executionReference).publish(publication)).rejects.toThrow(
      "closed",
    );
  } finally {
    clock.mockRestore();
    await publisher.close();
  }
});

it("needs no PG receipt or second payload ledger and leaves telemetry outside ACK semantics", async () => {
  const { scope, executionReference } = toolInvocationFixture();
  const publications: AcceptedDurableCommitFact[] = [];
  const channel: AcceptedFactWriter = {
    publication: { scope },

    commitNative: async (fact) => {
      publications.push(fact);
    },
  };
  const metrics = new PiCloudMetrics("publisher-observer");
  vi.spyOn(metrics, "observeSessionMutation").mockImplementation(() => {
    throw new Error("observer failed");
  });
  const publisher = new DurableSessionPublisher({
    metrics,
    replyTopic: "reply-worker-boot",
    channels: { resolve: () => channel, checkHealth: async () => {} },
  });
  for (let seq = 1; seq <= 100; seq++)
    await publisher.scoped(executionReference).publish({
      commit: { seq, nextId: 2, writes: [] },
      origins: [],
      tools: [],
      cancellations: [],
      display: [],
    });
  expect(publications).toHaveLength(100);
  expect(new Set(publications.map((f) => f.factId)).size).toBe(100);
  await publisher.close();
});
