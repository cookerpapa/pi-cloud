import { sql, type Kysely } from "kysely";
import { isDeepStrictEqual } from "node:util";
import type { Database } from "@pi-cloud/database";
import {
  durableControlIntent,
  parseControlToolDispatch,
  parseToolResultPayload,
  type ToolResultData,
  type ToolResultPayload,
  type ImagePacked,
} from "@pi-cloud/protocol";
import { encodeSessionImages, type ImageAttachmentCodec } from "@pi-cloud/session-attachments";
import type { ToolReply } from "@pi-cloud/event-log";
import type {
  AcceptedControlToolCommand,
  DurableControlToolDispatch,
} from "@pi-cloud/runtime-core/accepted-fact";
import type { KafkaAcceptedFactRecord } from "@pi-cloud/runtime-core/kafka-accepted-fact-consumer";
import { controlToolsForFact } from "@pi-cloud/runtime-core/tool-invocation-fact";

type Pending = {
  dispatch: DurableControlToolDispatch;
  sequence: number;
  partition: number;
  dirty: boolean;
  due: number;
  reply?: ImagePacked<ToolResultPayload>;
  replyBytes: number;
};
export type ControlToolOutcome =
  { waiting: true; until?: number } | { result: ToolResultData; isError?: boolean };
type Cursor = { tenant: string; session: string; seq: string; operation: string };

/** Reconciles repeatable control effects from native history. Pending memory
 * contains references; it is neither a task scheduler nor a durable command queue. */
export class ControlToolDispatcher {
  readonly #pending = new Map<string, Pending>();
  readonly #active = new Map<string, Promise<void>>();
  #generation = 0;
  #closed = false;
  #replyBytes = 0;
  readonly #timer: NodeJS.Timeout;
  constructor(
    readonly options: {
      database: Kysely<Database>;
      images?: ImageAttachmentCodec;
      partitions: number;
      ownsPartition(partition: number): boolean;
      execute(
        command: AcceptedControlToolCommand,
        current: () => boolean,
      ): Promise<ControlToolOutcome>;
      publish(topic: string, reply: ToolReply): Promise<void>;
      onError?(): void;
    },
  ) {
    this.#timer = setInterval(() => {
      const now = Date.now();
      for (const pending of this.#pending.values()) if (pending.due <= now) pending.dirty = true;
      this.#drain();
    }, 1000);
    this.#timer.unref();
  }
  #key(scope: DurableControlToolDispatch["scope"], operationId: string): string {
    return `${scope.tenantId}:${scope.piSessionId}:${operationId}`;
  }
  reset(): void {
    this.#generation++;
    this.#pending.clear();
    this.#replyBytes = 0;
  }
  async consume(
    record: KafkaAcceptedFactRecord,
    current: () => boolean = () => true,
  ): Promise<void> {
    if (this.#closed || !current()) return;
    const fact = record.fact;
    if (fact.kind === "execution_seal" || fact.kind === "work_finished") {
      for (const [key, pending] of this.#pending)
        if (
          pending.dispatch.scope.tenantId === fact.scope.tenantId &&
          pending.dispatch.scope.piSessionId === fact.scope.piSessionId &&
          pending.dispatch.scope.writerId === fact.scope.writerId
        )
          this.#remove(key);
      this.wake(fact.scope.tenantId, fact.scope.piSessionId);
      return;
    }
    if (fact.kind !== "durable_commit") return;
    // Validate the same-commit intent, but retain only the transport reference.
    // Recovery reads this exact descriptor from cloud_metadata; storing its
    // expanded arguments here would turn an ordinary replay into a conflict.
    controlToolsForFact(fact);
    for (const reference of fact.tools)
      if (reference.target === "control")
        this.#remember(reference, fact.commit.seq, record.partition);
    let changed = false;
    for (const write of fact.commit.writes) {
      if (write.type === "task") {
        const task = write.value as {
          id: number;
          kind: string;
          abortRequested: boolean;
          state: { status: string };
        };
        if (task.abortRequested || ["completing", "terminal"].includes(task.state.status))
          for (const [key, pending] of this.#pending)
            if (
              pending.dispatch.scope.tenantId === fact.scope.tenantId &&
              pending.dispatch.scope.piSessionId === fact.scope.piSessionId &&
              pending.dispatch.taskId === task.id
            )
              this.#remove(key);
        // Waiting on a Conversation needs its generation/ownership outcome,
        // not every Tool checkpoint on every sibling. Supervisor interactions
        // are woken by their ordered PG control change.
        if (task.kind === "pi.generation" && ["completing", "terminal"].includes(task.state.status))
          changed = true;
      } else if (
        write.type === "submission" &&
        ["done", "unanswered"].includes((write.value as { status: string }).status)
      )
        changed = true;
      else if (write.type === "document.retire")
        for (const [key, pending] of this.#pending)
          if (
            pending.dispatch.scope.tenantId === fact.scope.tenantId &&
            pending.dispatch.scope.piSessionId === fact.scope.piSessionId &&
            pending.dispatch.sourceDocumentId === write.id
          )
            this.#remove(key);
    }
    if (changed) this.wake(fact.scope.tenantId, fact.scope.piSessionId);
    this.#drain();
  }
  wake(tenantId: string, piSessionId: string): void {
    for (const pending of this.#pending.values())
      if (
        pending.dispatch.scope.tenantId === tenantId &&
        pending.dispatch.scope.piSessionId === piSessionId
      )
        pending.dirty = true;
    this.#drain();
  }
  #remember(dispatch: DurableControlToolDispatch, sequence: number, partition: number): void {
    const key = this.#key(dispatch.scope, dispatch.operationId);
    const prior = this.#pending.get(key);
    if (prior) {
      if (!isDeepStrictEqual(prior.dispatch, dispatch) || prior.sequence !== sequence)
        throw new Error("Control dispatch identity changed");
      return;
    }
    this.#pending.set(key, {
      dispatch,
      sequence,
      partition,
      dirty: true,
      due: Infinity,
      replyBytes: 0,
    });
  }
  #remove(key: string): void {
    const pending = this.#pending.get(key);
    if (pending) this.#replyBytes -= pending.replyBytes;
    this.#pending.delete(key);
  }
  /** Indexed current tasks only. Historical completed calls cannot be relaunched. */
  async recover(partitions: readonly number[], current: () => boolean): Promise<void> {
    if (!partitions.length) return;
    const generation = this.#generation;
    let cursor: Cursor | undefined;
    for (;;) {
      if (this.#closed || generation !== this.#generation || !current()) return;
      const rows = await sql<{
        tenant: string;
        session: string;
        seq: string;
        operation: string;
        dispatch: DurableControlToolDispatch;
        partition: number;
      }>`select c.tenant_id::text as tenant,c.session_id as session,c.seq::text,
          effect->>'operationId' as operation,effect as dispatch,
          (p.session_hash % ${this.options.partitions})::int as partition
        from pi_durable_commits c
        join pi_sessions p on p.tenant_id=c.tenant_id and p.id=c.session_id
        cross join lateral jsonb_array_elements(c.cloud_metadata::jsonb->'controlTools') effect
        join pi_durable_records r on r.tenant_id=c.tenant_id and r.session_id=c.session_id
          and r.id=(effect->>'taskId')::bigint and r.kind='task'
        where c.cloud_metadata is not null
          and r.fields->>'nativeKind'='"pi.tool"'
          and r.fields->>'status' in ('pending','running')
          and coalesce(r.fields->>'abortRequested','false')='false'
          and (effect->>'sourceDocumentId' is null or exists(
            select 1 from pi_durable_records doc where doc.tenant_id=c.tenant_id
              and doc.session_id=c.session_id and doc.id=(effect->>'sourceDocumentId')::bigint
              and doc.kind='document' and doc.retired_seq is null))
          and p.session_hash % ${this.options.partitions} = any(${[...partitions]}::int[])
          and ${cursor ? sql`(c.tenant_id,c.session_id,c.seq,effect->>'operationId')>(${cursor.tenant}::uuid,${cursor.session},${cursor.seq}::bigint,${cursor.operation})` : sql`true`}
        order by c.tenant_id,c.session_id,c.seq,effect->>'operationId' limit 128`.execute(
        this.options.database,
      );
      if (generation !== this.#generation || !current()) return;
      for (const row of rows.rows) {
        parseControlToolDispatch(row.dispatch);
        if (
          row.dispatch.scope.tenantId !== row.tenant ||
          row.dispatch.scope.piSessionId !== row.session
        )
          throw new Error("Stored control dispatch scope changed");
        this.#remember(row.dispatch, Number(row.seq), row.partition);
      }
      this.#drain();
      if (rows.rows.length < 128) return;
      cursor = rows.rows.at(-1)!;
    }
  }
  async #load(pending: Pending): Promise<AcceptedControlToolCommand | undefined> {
    const d = pending.dispatch;
    // Authority and the current task are checked together. This control-effect
    // admission query is not added to fixed Cube Tool dispatch.
    const row = await sql<{ body: string }>`select l.body from pi_durable_records r
      join pi_durable_log l on l.tenant_id=r.tenant_id and l.session_id=r.session_id
        and l.seq=${pending.sequence} and l.record_id=${d.sourceDocumentId ?? d.taskId}
        and l.record_kind=${d.sourceDocumentId === undefined ? "task" : "document.create"}
      join active_execution_scopes a on a.tenant_id=r.tenant_id
        and a.pi_session_id=r.session_id and a.run_id=${d.scope.runId}::uuid
      where r.tenant_id=${d.scope.tenantId}::uuid and r.session_id=${d.scope.piSessionId}
        and r.id=${d.taskId} and r.kind='task'
        and r.fields->>'conversation'=${String(d.conversationId)}
        and r.fields->>'status' in ('pending','running')
        and coalesce(r.fields->>'abortRequested','false')='false'
        and a.writer_id=${d.scope.writerId}::uuid and a.fencing_token=${d.scope.fencingToken}
        and a.valid_until>clock_timestamp() and a.accepting_effects`.execute(this.options.database);
    if (!row.rows[0]) return;
    const write = JSON.parse(row.rows[0].body) as Record<string, unknown>;
    if (d.sourceDocumentId !== undefined) {
      const live =
        await sql`select 1 from pi_durable_records where tenant_id=${d.scope.tenantId}::uuid
        and session_id=${d.scope.piSessionId} and id=${d.sourceDocumentId}
        and kind='document' and retired_seq is null`.execute(this.options.database);
      if (!live.rows.length) return;
    }
    const intent = durableControlIntent(
      {
        seq: pending.sequence,
        nextId: Math.max(d.taskId, d.sourceDocumentId ?? 0) + 1,
        writes: [write],
      },
      d,
    );
    return {
      ...d,
      kind: "control_tool",
      arguments: intent.arguments,
      nativeCallId: intent.callId,
      nativeSequence: pending.sequence,
    };
  }
  #drain(): void {
    if (this.#closed) return;
    for (const [key, pending] of this.#pending) {
      if (this.#active.size >= 128) break;
      if (!pending.dirty || this.#active.has(key) || !this.options.ownsPartition(pending.partition))
        continue;
      if (!pending.reply && this.#replyBytes >= 32 * 1024 * 1024) continue;
      pending.dirty = false;
      pending.due = Infinity;
      const generation = this.#generation;
      const current = () =>
        !this.#closed &&
        generation === this.#generation &&
        this.#pending.get(key) === pending &&
        this.options.ownsPartition(pending.partition);
      const task = this.#work(key, pending, current)
        .catch(() => {
          if (current()) {
            pending.due = Date.now() + 1000;
            this.options.onError?.();
          }
        })
        .finally(() => {
          if (this.#active.get(key) === task) this.#active.delete(key);
          this.#drain();
        });
      this.#active.set(key, task);
    }
  }
  async #work(key: string, pending: Pending, current: () => boolean): Promise<void> {
    const command = await this.#load(pending);
    if (!current()) return;
    if (!command) {
      this.#remove(key);
      return;
    }
    if (!pending.reply) {
      const outcome = await this.options.execute(command, current);
      if (!current()) return;
      if ("waiting" in outcome) {
        pending.due = outcome.until ?? Infinity;
        return;
      }
      const result = parseToolResultPayload({
        toolName: command.replyMode === "hostcall" ? "subagent-control" : command.toolName,
        toolCallId: command.nativeCallId,
        isError: outcome.isError ?? false,
        result: outcome.result,
      });
      const encoded = await encodeSessionImages(
        this.options.images,
        {
          tenantId: command.scope.tenantId,
          runId: command.scope.runId,
        },
        result,
      );
      if (!current()) return;
      pending.reply = encoded;
      pending.replyBytes = Buffer.byteLength(JSON.stringify(pending.reply));
      this.#replyBytes += pending.replyBytes;
    }
    await this.options.publish(command.replyTopic, {
      kind: "tool_result",
      operationId: command.operationId,
      sequence: 1,
      result: pending.reply,
    });
    if (current()) this.#remove(key);
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    this.reset();
    await Promise.allSettled(this.#active.values());
  }
}
