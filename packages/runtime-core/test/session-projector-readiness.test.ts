import { afterEach, expect, it, vi } from "vitest";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
const state = vi.hoisted(() => ({
  owned: new Set<number>(),
  owners: new Map<number, string>(),
  revoked: () => {},
}));
vi.mock("@pi-cloud/event-log", async (original) => ({
  ...(await original<typeof import("@pi-cloud/event-log")>()),
  KafkaLogConsumer: class {
    constructor(options: { onRevoked(): void }) {
      state.revoked = options.onRevoked;
    }
    async start() {}
    async close() {}
    ownsPartition(p: number) {
      return state.owned.has(p);
    }
    async partitionOwners() {
      return state.owners;
    }
  },
}));
vi.mock("../src/execution-log-topic.ts", () => ({
  ExecutionLogTopic: class {
    async start() {}
    async close() {}
  },
}));
vi.mock("../src/session-outbox-relay.ts", () => ({
  SessionOutboxRelay: class {
    start() {}
    async close() {}
  },
}));
vi.mock("../src/kafka-safe-retention.ts", () => ({
  KafkaSafeRetention: class {
    start() {}
    async close() {}
  },
}));
import { SessionProjector } from "../src/session-projector.ts";
import { HttpPublicationClient } from "../src/http-publication-client.ts";
const owner = (url: string) =>
  "pi-cloud-projector@" + Buffer.from(new URL(url).toString()).toString("base64url");
afterEach(() => {
  vi.restoreAllMocks();
  state.owned.clear();
  state.owners.clear();
});
function fixture() {
  return new SessionProjector({
    database: {} as Kysely<Database>,
    brokers: ["unused"],
    clientId: "test",
    notificationConnectionString: "postgresql://unused/test",
    partitions: 4,
    replicas: 3,
    retentionMs: 600000,
    advertisedBaseUrl: "http://local.test",
    publicationToken: "test",
    toolCommands: { consume: async () => {} },
  });
}
it("advertises only initialized owners and keeps healthy partitions available during peer failure", async () => {
  const p = fixture();
  try {
    await p.start();
    state.owned.add(0);
    state.owned.add(1);
    for (const n of [0, 1]) state.owners.set(n, owner("http://local.test"));
    state.owners.set(2, owner("http://peer.test"));
    state.owners.set(3, owner("http://dead.test"));
    p.publication.installPartition(0, {
      close: async () => {},
      append: async () => {
        throw new Error("unused");
      },
    });
    const remote = vi
      .spyOn(HttpPublicationClient.prototype, "publicationAvailability")
      .mockImplementation(async (url) => {
        if (url?.includes("dead")) throw new Error("unreachable");
        return { partitionCount: 4, partitions: [0, 1, 2, 3] };
      });
    const reports = await Promise.all(
      Array.from({ length: 20 }, () => p.publicationAvailability()),
    );
    expect(reports.every((r) => r.partitions.join() === "0,2")).toBe(true);
    expect(remote).toHaveBeenCalledTimes(2);
    expect(p.localPublicationAvailability().partitions).toEqual([0]);
    state.revoked();
    state.owned.clear();
    expect((await p.publicationAvailability()).partitions).toEqual([2]);
  } finally {
    await p.close();
  }
});
it("discards delayed peer success across assignment replacement", async () => {
  const p = fixture(),
    reply = Promise.withResolvers<{ partitionCount: number; partitions: number[] }>();
  try {
    await p.start();
    state.owners.set(2, owner("http://peer.test"));
    const remote = vi
      .spyOn(HttpPublicationClient.prototype, "publicationAvailability")
      .mockReturnValue(reply.promise);
    const pending = p.publicationAvailability();
    await vi.waitFor(() => expect(remote).toHaveBeenCalledOnce());
    state.revoked();
    reply.resolve({ partitionCount: 4, partitions: [2] });
    await expect(pending).rejects.toThrow("ownership changed");
  } finally {
    await p.close();
  }
});
