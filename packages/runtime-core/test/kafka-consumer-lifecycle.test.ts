import { expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  created: 0,
  disconnected: 0,
  metadataMisses: 0,
  metadataCode: 3,
  invalidBounds: 0,
}));
vi.mock("@confluentinc/kafka-javascript", () => ({
  default: {
    CODES: {
      ERRORS: { ERR_UNKNOWN_TOPIC_OR_PART: 3, ERR_LEADER_NOT_AVAILABLE: 5, ERR__NOENT: -156 },
    },
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
              if (fixture.invalidBounds > 0) {
                fixture.invalidBounds--;
                return [{ partition: 0, offset: "-1", low: "-1", high: "-1" }];
              }
              if (fixture.metadataMisses > 0) {
                fixture.metadataMisses--;
                throw Object.assign(new Error("topic metadata is propagating"), {
                  code: fixture.metadataCode,
                });
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
  await expect(consumer.captureEndOffsets()).rejects.toThrow("temporary admin connection failure");
  await expect(consumer.captureEndOffsets()).resolves.toEqual([0n]);
  expect(fixture.created).toBe(2);
  await consumer.close();
  expect(fixture.disconnected).toBe(2);
});

it.each([3, 5, -156])(
  "waits for fresh-topic metadata propagation (%s) without replacing an established Admin",
  async (code) => {
    fixture.created = 1;
    fixture.metadataMisses = 1;
    fixture.metadataCode = code;
    const consumer = new KafkaAcceptedFactConsumer({
      brokers: ["unused:9092"],
      topic: "new-topic",
      clientId: "test",
      groupId: "test",
      handler: async () => {},
    });
    await expect(consumer.captureEndOffsets()).resolves.toEqual([0n]);
    expect(fixture.metadataMisses).toBe(0);
    expect(fixture.created).toBe(2);
    await consumer.close();
  },
);

it("does not retry a permanent metadata failure", async () => {
  fixture.created = 1;
  fixture.metadataMisses = 1;
  fixture.metadataCode = 29;
  const consumer = new KafkaAcceptedFactConsumer({
    brokers: ["unused:9092"],
    topic: "forbidden",
    clientId: "test",
    groupId: "test",
    handler: async () => {},
  });
  try {
    await expect(consumer.captureEndOffsets()).rejects.toMatchObject({ code: 29 });
  } finally {
    await consumer.close();
  }
});

it("never treats metadata propagation sentinels as real Kafka offsets", async () => {
  fixture.created = 1;
  fixture.metadataMisses = 0;
  fixture.invalidBounds = 1;
  const consumer = new KafkaAcceptedFactConsumer({
    brokers: ["unused"],
    topic: "new-topic",
    clientId: "test",
    groupId: "test",
    handler: async () => {},
  });
  try {
    await expect(consumer.captureEndOffsets()).resolves.toEqual([0n]);
    expect(fixture.invalidBounds).toBe(0);
  } finally {
    await consumer.close();
  }
});
