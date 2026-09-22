import { ProtocolError } from "@platformatic/kafka";
import type { Database } from "@pi-cloud/database";
import { TOOL_REPLY_RETENTION_MS, toolReplyTopic } from "@pi-cloud/event-log";
import type { Kysely } from "kysely";
import { expect, it, vi } from "vitest";
import { KafkaSafeRetention } from "../src/kafka-safe-retention.ts";

const boot = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";

function fixture(topics = [toolReplyTopic(boot), toolReplyTopic(other)]) {
  const query: Record<string, any> = {};
  for (const name of ["select", "where", "limit"]) query[name] = vi.fn(() => query);
  query.execute = vi.fn(async () => [{ boot_id: boot }]);
  const database = {
    getExecutor: () => ({
      transformQuery: (query: unknown) => query,
      compileQuery: () => ({}),
      executeQuery: async () => ({ rows: [] }),
    }),
    selectFrom: vi.fn(() => query),
  } as unknown as Kysely<Database>;
  const admin = {
    listOffsets: vi.fn(async () => []),
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
