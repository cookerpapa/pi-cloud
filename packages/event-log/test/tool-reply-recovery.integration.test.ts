import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { KafkaLogConsumer } from "../src/kafka-log-consumer.ts";
import {
  KafkaToolReplyMailbox,
  KafkaToolReplyPublisher,
  type ToolReply,
} from "../src/tool-replies.ts";

const brokers = process.env.PI_CLOUD_KAFKA_INTEGRATION_BROKERS?.split(",");
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
      if (value.kind !== "execution_probe")
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
      if (errors.length) throw new AggregateError(errors, "Reply transport fixture cleanup failed");
    }
  },
  120000,
);
