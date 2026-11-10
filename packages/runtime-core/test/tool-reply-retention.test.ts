import { ProtocolError } from "@platformatic/kafka";
import type { Database } from "@pi-cloud/database";
import { TOOL_REPLY_RETENTION_MS, toolReplyTopic } from "@pi-cloud/event-log";
import type { Kysely } from "kysely";
import { expect, it, vi } from "vitest";
import { KafkaSafeRetention } from "../src/kafka-safe-retention.ts";

const boot = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";

function fixture(
  topics = [toolReplyTopic(boot), toolReplyTopic(other)],
  pending: { topic: string; floor: string }[] = [],
) {
  const query: Record<string, any> = {};
  for (const name of ["select", "where", "limit"]) query[name] = vi.fn(() => query);
  query.execute = vi.fn(async () => [{ boot_id: boot }]);
  const database = {
    getExecutor: () => ({
      transformQuery: (query: unknown) => query,
      compileQuery: (node: unknown) => ({ sql: JSON.stringify(node) }),
      executeQuery: async ({ sql }: { sql: string }) => ({
        rows: sql.includes("pi_durable_owned_records") ? pending : [],
      }),
    }),
    selectFrom: vi.fn(() => query),
  } as unknown as Kysely<Database>;
  const admin = {
    listOffsets: vi.fn(async (_request?: unknown): Promise<any[]> => []),
    deleteRecords: vi.fn(async () => []),
    listTopics: vi.fn(async () => topics),
    listGroups: vi.fn(
      async () =>
        new Map([
          [`tool-reply-${boot}`, {}],
          ["unrelated", {}],
        ]),
    ),
    deleteTopics: vi.fn(async () => {}),
    deleteGroups: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const reaper = new KafkaSafeRetention({
    database,
    brokers: [],
    topic: "log",
    clientId: "test",
    graceMs: 1000,
    admin: admin as any,
  });
  return { reaper, admin, query };
}

it("only reaps positively retired old boots, including groups left after Topic deletion", async () => {
  const { reaper, admin, query } = fixture([]);
  await reaper.sweep(1_000_000);
  expect(query.where).toHaveBeenCalledWith("state", "=", "completed");
  expect(query.where).toHaveBeenCalledWith(
    "completed_at",
    "<",
    new Date(1_000_000 - TOOL_REPLY_RETENTION_MS),
  );
  expect(admin.deleteTopics).not.toHaveBeenCalled();
  expect(admin.deleteGroups).toHaveBeenCalledExactlyOnceWith({ groups: [`tool-reply-${boot}`] });
});

it("treats concurrent deletion as success without swallowing other Kafka failures", async () => {
  const { reaper, admin } = fixture();
  admin.deleteTopics.mockRejectedValue(new AggregateError([new ProtocolError(3)]));
  admin.deleteGroups.mockRejectedValue(new AggregateError([new ProtocolError(69)]));
  await expect(reaper.sweep()).resolves.toBeUndefined();
  expect(admin.deleteTopics).toHaveBeenCalledExactlyOnceWith({ topics: [toolReplyTopic(boot)] });
  admin.deleteTopics.mockRejectedValue(new Error("network lost"));
  await expect(reaper.sweep()).rejects.toThrow("network lost");
});

it("protects an old boot's reply suffix until native settlement releases its reference", async () => {
  const topic = toolReplyTopic(boot),
    pending = [{ topic, floor: "20" }];
  const { reaper, admin } = fixture([topic], pending);
  admin.listOffsets.mockImplementation(async ({ topics }: any) =>
    topics.map(({ name, partitions }: any) => ({
      name,
      partitions: partitions.map(({ partitionIndex, timestamp }: any) => ({
        partitionIndex,
        offset: timestamp === -1n ? 100n : 80n,
      })),
    })),
  );
  try {
    await reaper.sweep();
    expect(admin.deleteRecords).toHaveBeenCalledExactlyOnceWith({
      topics: [{ name: topic, partitions: [{ partition: 0, offset: 20n }] }],
    });
    expect(admin.deleteTopics).not.toHaveBeenCalled();
    expect(admin.deleteGroups).not.toHaveBeenCalled();
    pending.length = 0; // Native result committed; consumer progress alone never does this.
    admin.deleteRecords.mockClear();
    await reaper.sweep();
    expect(admin.deleteRecords).toHaveBeenCalledExactlyOnceWith({
      topics: [{ name: topic, partitions: [{ partition: 0, offset: 80n }] }],
    });
    expect(admin.deleteTopics).toHaveBeenCalledExactlyOnceWith({ topics: [topic] });
    expect(admin.deleteGroups).toHaveBeenCalledExactlyOnceWith({ groups: [`tool-reply-${boot}`] });
  } finally {
    await reaper.close();
  }
});
