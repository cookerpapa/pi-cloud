import { expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ created: 0, disconnected: 0, metadataMisses: 0 }));
vi.mock("@confluentinc/kafka-javascript", () => ({
  default: {
    CODES: { ERRORS: { ERR_UNKNOWN_TOPIC_OR_PART: 3, ERR_LEADER_NOT_AVAILABLE: 5 } },
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
              if (fixture.metadataMisses > 0) {
                fixture.metadataMisses--;
                throw Object.assign(new Error("topic metadata is propagating"), { code: 3 });
              }
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

it("waits for fresh-topic metadata propagation without replacing an established Admin", async () => {
  fixture.created = 1;
  fixture.metadataMisses = 1;
  const consumer = new KafkaAcceptedFactConsumer({
    brokers: ["unused:9092"],
    topic: "new-topic",
    clientId: "test",
    groupId: "test",
    handler: async () => {},
  });
  await expect(consumer.partitionCount()).resolves.toBe(1);
  expect(fixture.metadataMisses).toBe(0);
  expect(fixture.created).toBe(2);
  await consumer.close();
});
