import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { KafkaLogConsumer } from "../src/kafka-log-consumer.ts";
import { Admin } from "@platformatic/kafka";
import {
  KafkaToolReplyMailbox,
  KafkaToolReplyPublisher,
  type ToolReply,
} from "../src/tool-replies.ts";

const brokers = process.env.PI_CLOUD_KAFKA_INTEGRATION_BROKERS?.split(",");
it.skipIf(!brokers)(
  "a replacement reads a delivered but uncommitted result and follows an original pending operation",
  async () => {
    const a = new KafkaToolReplyMailbox({ brokers: brokers!, replicas: 3, bootId: randomUUID() });
    const b = new KafkaToolReplyMailbox({ brokers: brokers!, replicas: 3, bootId: randomUUID() });
    const c = new KafkaToolReplyMailbox({ brokers: brokers!, replicas: 3, bootId: randomUUID() });
    const publisher = new KafkaToolReplyPublisher(brokers!, `handoff-${randomUUID()}`);
    const authority = new AbortController();
    const admin = new Admin({ bootstrapBrokers: brokers!, clientId: `cleanup-${randomUUID()}` });
    const reply = (operationId: string): ToolReply => ({
      kind: "tool_result",
      operationId,
      sequence: 1,
      result: {
        toolCallId: operationId,
        toolName: "bash",
        isError: false,
        result: { content: [{ type: "text", text: `original:${operationId}` }] },
      },
    });
    let closedA = false,
      closedB = false;
    try {
      await a.start();
      await b.start();
      await c.start();
      await publisher.start();
      const start = await a.replyPosition();
      const refs = ["completed", "running"].map((operationId) => ({
        operationId,
        reply: {
          ...start,
          toolCallId: operationId,
          toolName: "bash",
          // The completed reply must win despite downtime exceeding its deadline.
          deadlineAt: Date.now() + (operationId === "completed" ? -1 : 60_000),
        },
      }));
      const receivedByA = a.wait("completed", "completed", "bash", authority.signal);
      await publisher.publish(a.topic, reply("completed"));
      await receivedByA.result;
      await a.shutdown();
      closedA = true;
      await b.restore(refs, authority.signal);
      const done = b.resumeWait("completed", refs[0]!.reply, authority.signal);
      expect((await done.result).result.content).toEqual([
        { type: "text", text: "original:completed" },
      ]);
      const running = b.resumeWait("running", refs[1]!.reply, authority.signal);
      // B is replaced while still waiting. Neither B's consumed prefix nor its
      // private group offset is proof of a native result commit. C restores the
      // same original references, including the already-delivered result.
      const abandoned = expect(running.result).rejects.toThrow();
      await b.shutdown();
      closedB = true;
      await abandoned;
      const restoring = c.restore(refs, authority.signal);
      await publisher.publish(a.topic, reply("unrelated"));
      await publisher.publish(a.topic, reply("completed")); // duplicate is harmless
      await publisher.publish(a.topic, reply("running")); // original destination, never B's Topic
      await restoring;
      expect(
        (await c.resumeWait("completed", refs[0]!.reply, authority.signal).result).result.content,
      ).toEqual([{ type: "text", text: "original:completed" }]);
      expect(
        (await c.resumeWait("running", refs[1]!.reply, authority.signal).result).result.content,
      ).toEqual([{ type: "text", text: "original:running" }]);
      expect(c.size).toBe(0);
      // Kafka retention follows native settlement, not consumption by either boot.
      expect((await admin.listTopics()).includes(a.topic)).toBe(true);
    } finally {
      authority.abort();
      await c.shutdown();
      if (!closedB) await b.shutdown();
      if (!closedA) await a.shutdown();
      await publisher.close();
      await admin.deleteTopics({ topics: [a.topic, b.topic, c.topic] });
      await admin.close();
    }
  },
  120_000,
);
it.skipIf(!brokers)(
  "resumes the original boot's callbacks after reassignment without reading its delivered prefix",
  async () => {
    const bootId = randomUUID();
    const mailbox = new KafkaToolReplyMailbox({ brokers: brokers!, replicas: 3, bootId });
    const publisher = new KafkaToolReplyPublisher(brokers!, "reply-recovery-" + bootId);
    const counts = new Map<string, number>();
    let callbacks = 0,
      joined = false;
    let competitor: KafkaLogConsumer<unknown> | undefined;
    const accept = mailbox.accept.bind(mailbox);
    mailbox.accept = (value) => {
      if ("operationId" in value)
        counts.set(value.operationId, (counts.get(value.operationId) ?? 0) + 1);
      accept(value);
    };
    const reply = (id: string): ToolReply => ({
      kind: "tool_result",
      operationId: id,
      sequence: 1,
      result: {
        toolCallId: "call",
        toolName: "bash",
        isError: false,
        result: { content: [{ type: "text", text: "x".repeat(16384) }] },
      },
    });
    try {
      expect(mailbox.ready).toBe(false);
      await mailbox.start();
      await publisher.start();
      expect(mailbox.ready).toBe(true);
      const old = mailbox.wait("old", "call", "bash", new AbortController().signal);
      void old.result.then(() => {
        callbacks++;
      });
      await Promise.all(
        Array.from({ length: 100 }, (_, n) =>
          publisher.publish(mailbox.topic, reply(n === 99 ? "old" : "retired-" + n)),
        ),
      );
      await old.result;
      await vi.waitFor(() => expect(counts.size).toBe(100), { timeout: 30000 });
      competitor = new KafkaLogConsumer({
        brokers: brokers!,
        topic: mailbox.topic,
        clientId: "reply-recovery-peer-" + bootId,
        groupId: "tool-reply-" + bootId,
        commitMessages: false,
        decode: (value) => JSON.parse(value.toString()),
        handler: async () => {},
        onAssigned: async () => {
          joined = true;
        },
      });
      await competitor.start();
      await vi.waitFor(() => expect(joined).toBe(true), { timeout: 30000 });
      await competitor.close();
      competitor = undefined;
      await vi.waitFor(() => expect(mailbox.ready).toBe(true), { timeout: 30000 });
      const next = mailbox.wait("next", "call", "bash", new AbortController().signal);
      void next.result.then(() => {
        callbacks++;
      });
      await publisher.publish(mailbox.topic, reply("next"));
      await next.result;
      expect(callbacks).toBe(2);
      expect(counts.size).toBe(101);
      for (const [id, deliveries] of counts) if (id !== "next") expect(deliveries).toBe(1);
      expect(mailbox.size).toBe(0);
      expect(old.executionSettled() && next.executionSettled()).toBe(true);
    } finally {
      const closed = await Promise.allSettled([
        competitor?.close(),
        publisher.close(),
        mailbox.shutdown(),
      ]);
      const errors = closed.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
      const admin = new Admin({ bootstrapBrokers: brokers!, clientId: `reply-cleanup-${bootId}` });
      try {
        await admin.deleteTopics({ topics: [mailbox.topic] });
      } finally {
        await admin.close();
      }
      if (errors.length) throw new AggregateError(errors, "Reply transport fixture cleanup failed");
    }
  },
  120000,
);
