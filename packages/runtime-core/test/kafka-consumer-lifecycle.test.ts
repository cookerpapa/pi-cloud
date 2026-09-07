import { expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ created: 0, disconnected: 0 }));
vi.mock("@confluentinc/kafka-javascript", () => ({
  default: {
    CODES: { ERRORS: {} },
    KafkaJS: {
      logLevel: { NOTHING: 0 },
      Kafka: class {
        admin() {
          const fail = fixture.created++ === 0;
          return {
            async connect() {
              if (fail) throw new Error("temporary admin connection failure");
            },
            async disconnect() {
              fixture.disconnected++;
            },
            async fetchTopicOffsets() {
              return [{ partition: 0, low: "0", high: "0", offset: "0" }];
            },
          };
        }
      },
    },
  },
}));
import { KafkaAcceptedFactConsumer } from "../src/kafka-accepted-fact-consumer.ts";

it("replaces an Admin whose initial connection failed instead of caching its rejected promise", async () => {
  const consumer = new KafkaAcceptedFactConsumer({
    brokers: ["unused:9092"],
    topic: "test",
    clientId: "test",
    groupId: "test",
    handler: async () => {},
  });
  await expect(consumer.partitionCount()).rejects.toThrow("temporary admin connection failure");
  await expect(consumer.partitionCount()).resolves.toBe(1);
  expect(fixture.created).toBe(2);
  await consumer.close();
  expect(fixture.disconnected).toBe(2);
});
