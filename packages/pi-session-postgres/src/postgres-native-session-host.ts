import type { Database } from "@pi-cloud/database";
import { parseExecutionLease } from "@pi-cloud/protocol";
import {
  SessionError,
  type LaneRecord,
  type OperationStartedRecord,
} from "@earendil-works/pi-agent-core";
import { sql, type Kysely } from "kysely";
import {
  NativeSessionWriter,
  type NativeLaneSessionStorage,
  type NativeViewRead,
} from "./native-session-writer.ts";
import { PostgresPiSessionStorage } from "./postgres-session-storage.ts";
import { PostgresRunExecutionAuthority } from "./postgres-execution-authority.ts";
import type { PiSessionAppendPublisher } from "./session-mutation.ts";
import type { PostgresPiSessionEntryPayloadCache } from "./session-entry-payload-cache.ts";
export type CloudAgentExecutionScope = Readonly<{
  tenantId: string;
  sessionId: string;
  piSessionId: string;
  piSessionLane: string;
  turnId: string;
  runId: string;
}>;

export type NativeSessionOpen = {
  scope: CloudAgentExecutionScope;
  writerId: string;
  executionLease: string;
  publisher: PiSessionAppendPublisher;
};

/** Worker composition only. Cold bootstrap reads PG; the public SessionStorage
 * handed to the Harness keeps its active view and writes to the durable port. */
export class PostgresNativeSessionHost {
  readonly #database: Kysely<Database>;
  readonly #cache: PostgresPiSessionEntryPayloadCache | undefined;
  readonly #onViewRead: ((sample: NativeViewRead) => void) | undefined;
  readonly #writers = new Map<string, Promise<NativeSessionWriter>>();
  readonly #leases = new Map<string, NativeLaneSessionStorage>();
  readonly #reaper: NodeJS.Timeout;
  #closed = false;

  constructor(options: {
    database: Kysely<Database>;
    entryPayloadCache?: PostgresPiSessionEntryPayloadCache;
    onViewRead?: (sample: NativeViewRead) => void;
  }) {
    this.#database = options.database;
    this.#cache = options.entryPayloadCache;
    this.#onViewRead = options.onViewRead;
    this.#reaper = setInterval(() => void this.#reap().catch(() => {}), 60_000);
    this.#reaper.unref();
  }

  async #reap() {
    for (const [key, pending] of this.#writers) {
      const writer = await pending;
      if (writer.activeLanes) continue;
      const active = await this.#database
        .selectFrom("run_attempts")
        .select("id")
        .where("native_writer_id", "=", writer.id)
        .where("state", "in", [
          "claimed",
          "provisioning",
          "restoring",
          "running",
          "settling",
          "cancel_requested",
        ])
        .limit(1)
        .executeTakeFirst();
      if (!active && !writer.activeLanes && this.#writers.get(key) === pending)
        this.#writers.delete(key);
    }
  }

  async #writer(input: NativeSessionOpen) {
    const key = `${input.scope.tenantId}:${input.scope.piSessionId}:${input.writerId}`;
    let pending = this.#writers.get(key);
    if (!pending) {
      pending = this.#loadWriter(input);
      this.#writers.set(key, pending);
      void pending.catch(() => {
        if (this.#writers.get(key) === pending) this.#writers.delete(key);
      });
    }
    return pending;
  }

  #reader(scope: CloudAgentExecutionScope) {
    return new PostgresPiSessionStorage({
      database: this.#database,
      tenantId: scope.tenantId,
      sessionId: scope.piSessionId,
      ...(this.#cache ? { entryPayloadCache: this.#cache } : {}),
    });
  }

  async #loadWriter({ scope, writerId }: NativeSessionOpen) {
    const reader = this.#reader(scope);
    const session = await this.#database
      .selectFrom("pi_sessions")
      .select(["next_seq", "active_writer_id"])
      .where("tenant_id", "=", scope.tenantId)
      .where("id", "=", scope.piSessionId)
      .executeTakeFirstOrThrow();
    if (session.active_writer_id !== writerId)
      throw new Error("Native Session ownership changed before bootstrap");
    return new NativeSessionWriter({
      id: writerId,
      ...(this.#onViewRead ? { onViewRead: this.#onViewRead } : {}),
      metadata: await reader.getMetadata(),
      nextSequence: Number(session.next_seq),
      lanes: await reader.getLanes(),
      hasId: async (id) => {
        const result = await sql<{ found: boolean }>`select exists(
          select 1 from pi_session_visible_entries where tenant_id=${scope.tenantId}::uuid and session_id=${scope.piSessionId} and id=${id}
          union all select 1 from pi_session_records where tenant_id=${scope.tenantId}::uuid and session_id=${scope.piSessionId} and id=${id}
        ) as found`.execute(this.#database);
        return result.rows[0]!.found;
      },
      waitProjected: async (through, signal) => {
        while (true) {
          signal?.throwIfAborted();
          if (this.#closed) throw new Error("Native Session host is closed");
          const current = await this.#database
            .selectFrom("pi_sessions")
            .select(["next_seq", "active_writer_id"])
            .where("tenant_id", "=", scope.tenantId)
            .where("id", "=", scope.piSessionId)
            .executeTakeFirstOrThrow();
          if (Number(current.next_seq) > through) return;
          if (current.active_writer_id !== writerId)
            throw new Error("Native Session ownership changed while reading history");
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      },
      fail: async () => {
        await this.#database
          .updateTable("run_attempts")
          .set({ native_writer_failed_at: new Date() })
          .where("tenant_id", "=", scope.tenantId)
          .where("id", "=", writerId)
          .where("native_writer_failed_at", "is", null)
          .execute();
      },
    });
  }

  async open(input: NativeSessionOpen) {
    if (this.#closed) throw new Error("Native Session host is closed");
    const { scope, executionLease, publisher } = input;
    const authority = new PostgresRunExecutionAuthority({
      database: this.#database,
      tenantId: scope.tenantId,
      sessionId: scope.sessionId,
      runId: scope.runId,
      turnId: scope.turnId,
      executionLease,
    });
    let lane: NativeLaneSessionStorage | undefined;
    try {
      await authority.assertCurrent();
      const writer = await this.#writer(input);
      const reader = this.#reader(scope);
      const head = writer.lanes().find((l) => l.lane === scope.piSessionLane);
      if (!head)
        throw new SessionError("invalid_lane", "Native Lane was not acknowledged by this writer");
      const childSeed = writer.seedFor(scope.piSessionLane);
      const readingAt = performance.now();
      const branch =
        childSeed ??
        (head.leafId
          ? (
              await reader.findEntriesOnBranch({
                start: head.leafId,
                stopAtType: "compaction",
                order: "newestFirst",
              })
            ).reverse()
          : []);
      if (this.#onViewRead && (head.leafId !== null || childSeed !== undefined))
        this.#onViewRead({
          source: childSeed === undefined ? "storage" : "memory",
          durationMs: performance.now() - readingAt,
          storageBytes: childSeed === undefined ? Buffer.byteLength(JSON.stringify(branch)) : 0,
        });
      const open =
        childSeed === undefined
          ? await reader.findOpenOperations(scope.piSessionLane, { limit: 2 })
          : [];
      if (open.length > 1) throw new Error("Pi Lane contains multiple unfinished operations");
      const oldIds = open.map((r) => r.id);
      const rows = oldIds.length
        ? await this.#database
            .selectFrom("pi_session_records")
            .select(["id", "turn_id", "type", "payload"])
            .where("tenant_id", "=", scope.tenantId)
            .where("session_id", "=", scope.piSessionId)
            .where("run_id", "in", oldIds)
            .where("type", "in", ["operation_started", "tool_started"])
            .orderBy("seq", "asc")
            .execute()
        : [];
      lane = await writer.open(
        {
          lane: scope.piSessionLane,
          turnId: scope.turnId,
          attemptId: parseExecutionLease(executionLease).attemptId,
        },
        {
          branch,
          reader,
          openOperations: rows
            .filter((r) => r.type === "operation_started")
            .map((r) => ({
              record: r.payload as unknown as OperationStartedRecord,
              turnId: r.turn_id,
            })),
          records: rows
            .filter((r) => r.type === "tool_started")
            .map((r) => r.payload as unknown as LaneRecord),
        },
        publisher,
      );
      this.#leases.set(executionLease, lane);
      const recoveries = await this.#database
        .selectFrom("session_terminal_events as terminal")
        .innerJoin("turns as turn", "turn.id", "terminal.turn_id")
        .select(["terminal.event_id", "terminal.turn_id", "terminal.interrupted_prefix"])
        .where("terminal.tenant_id", "=", scope.tenantId)
        .where("terminal.session_id", "=", scope.sessionId)
        .where("terminal.interrupted_prefix", "is not", null)
        .where("turn.pruned_at", "is", null)
        .orderBy("terminal.seq", "asc")
        .execute();
      for (const recovery of recoveries)
        await lane.appendRecovery(
          {
            id: `pc-interrupted-${recovery.event_id}`,
            type: "custom",
            customType: "pi-cloud.interrupted_assistant_prefix",
            data: { text: recovery.interrupted_prefix! },
          },
          recovery.turn_id,
          recovery.event_id,
        );
      authority.start();
      const storage = lane;
      const signal = AbortSignal.any([authority.signal, writer.signal]);
      return {
        session: storage.asSession(),
        lane: scope.piSessionLane,
        mutationPublisher: storage.mutationPort(),
        authority: {
          signal,
          assertCurrent: async () => {
            signal.throwIfAborted();
            await authority.assertCurrent();
          },
          close: async () => {
            this.#leases.delete(executionLease);
            storage.close();
            await authority.close();
          },
        },
      };
    } catch (error) {
      this.#leases.delete(executionLease);
      lane?.close();
      await authority.close();
      throw error;
    }
  }

  childAnchor(executionLease: string, inherit: boolean) {
    const parent = this.#leases.get(executionLease);
    if (!parent || parent.closed) throw new Error("Parent native Session writer is unavailable");
    return inherit ? (parent.baseContext().at(-1)?.id ?? null) : null;
  }

  async createChildLane(input: { executionLease: string; lane: string; at: string | null }) {
    const parent = this.#leases.get(input.executionLease);
    if (!parent || parent.closed) throw new Error("Parent native Session writer is unavailable");
    const existing = (await parent.getLanes()).find((lane) => lane.lane === input.lane);
    if (existing) {
      if (existing.leafId !== input.at) throw new Error("Prepared Child Lane identity changed");
      return;
    }
    await parent.createLane(input.lane, input.at);
  }

  close() {
    this.#closed = true;
    clearInterval(this.#reaper);
    this.#writers.clear();
  }
}
