import { expect, it, vi } from "vitest";
import { KafkaLogConsumer } from "../src/kafka-log-consumer.ts";

it("does not install a delayed owner lookup after consumer retirement", async () => {
  const pending = Promise.withResolvers<ReadonlyMap<number, string>>();
  const readPartitionOwners = vi.fn(() => pending.promise);
  const consumer = new KafkaLogConsumer({
    brokers: ["127.0.0.1:1"],
    clientId: "owner-fixture",
    groupId: "owner-fixture",
    topic: "owner-fixture",
    decode: () => ({}),
    handler: async () => {},
    readPartitionOwners,
  });
  const first = consumer.partitionOwners();
  const second = consumer.partitionOwners();
  expect(readPartitionOwners).toHaveBeenCalledOnce();
  await consumer.close();
  pending.resolve(new Map([[0, "retired-owner"]]));
  await expect(first).rejects.toThrow("ownership changed");
  await expect(second).rejects.toThrow("ownership changed");
  await expect(consumer.partitionOwners()).rejects.toThrow("closing");
});

it("keeps absent membership unavailable instead of inventing an owner", async () => {
  const consumer = new KafkaLogConsumer({
    brokers: ["127.0.0.1:1"],
    clientId: "owner-fixture",
    groupId: "owner-fixture",
    topic: "owner-fixture",
    decode: () => ({}),
    handler: async () => {},
    readPartitionOwners: async () => new Map(),
  });
  try {
    expect(await consumer.ownerClientId(0)).toBeUndefined();
  } finally {
    await consumer.close();
  }
});
