import { NativeProjectionProgress } from "../native-projection-progress.ts";
import { nativeRead } from "./read-lifetime.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { setImmediate as yieldToIo } from "node:timers/promises";
import type { Kysely } from "kysely";
import { isTransientDatabaseReadError, type Database } from "@pi-cloud/database";
import { NativeSessionError } from "../native-session-error.ts";
import {
  parseExecutionReference,
  parseControlToolDispatch,
  durableControlIntent,
  PublicationNotSentError,
  type SupervisorHeartbeatMessage,
  type SupervisorHeartbeatAckMessage,
  type DurableCommitPublication,
  type DurableSessionCommit,
  type OriginalControlToolIntent,
  type OriginalRemoteToolIntent,
  type AcceptedToolCommand,
  type AcceptedExecutorToolCommand,
  type PendingToolReplyRecovery,
  parseToolReplyRecovery,
  durableToolIntent,
  parseToolSandboxOperationRequest,
  durableToolState,
} from "@pi-cloud/protocol";
import type { ImageAttachmentCodec } from "@pi-cloud/session-attachments";
import type { ActiveExecutionAuthority } from "../execution-authority.ts";
import { PostgresSessionLeaseObserver } from "../postgres-session-lease-observer.ts";
import { DurablePostgresProjection } from "./postgres-projection.ts";
import { PublishedDurableStorage, type NativeDocumentChange } from "./published-storage.ts";
import { sql } from "kysely";
import { type ConversationWorkView } from "@pi-cloud/protocol";

export type DurableRunBinding = Readonly<{
  tenantId: string;
  piSessionId: string;
  conversationId: number;
  sessionId: string;
  turnId: string;
  runId: string;
  executionReference: string;
  writerId: string;
}>;
export type DurableSessionOpen = {
  binding: DurableRunBinding;
  stopOnResume?: boolean;
  /** Owner/startup lifetime, excluding User Stop's native settlement. */
  signal?: AbortSignal;
  publish(publication: DurableCommitPublication): Promise<void>;
};
export type NativePublicationPreparation = {
  tools: DurableCommitPublication["tools"];
  cancellations: DurableCommitPublication["cancellations"];
  confirmed(): void;
};
export type NativeDisplayPreparation = {
  events: DurableCommitPublication["display"][number]["events"];
  coveredThrough?: number;
  confirmed(): void;
};
type PrepareDisplay = (
  commit: DurableSessionCommit,
  documents: readonly NativeDocumentChange[],
) => NativeDisplayPreparation;
export type ManagedNativeRuntime = {
  close(): Promise<void>;
  publishControl?(
    taskId: number,
    command: import("@pi-cloud/protocol").CandidateControlToolCommand,
  ): Promise<void>;
  retireHostCall?(taskId: number, id: string): Promise<void>;
  stopConversation?(requestId: string): Promise<void>;
  activeConversationViews?(
    runId: string,
  ): Promise<Array<{ conversationId: number; view: ConversationWorkView }>>;
  childAnchor?(conversationId: number): Promise<number | undefined>;
  createConversation?(input: {
    requestId: string;
    ownerTaskId: number;
    parentConversationId: number;
    at?: number;
    view?: ConversationWorkView;
  }): Promise<number>;
};
type RemoteToolMetadata =
  | (Omit<AcceptedToolCommand, "kind" | "toolCallId" | "request"> & {
      target: "cube";
      taskId: number;
      request: Omit<
        Extract<AcceptedToolCommand["request"], { operation: "tool.execute" }>,
        "args" | "toolCallId"
      >;
    })
  | (Omit<AcceptedExecutorToolCommand, "kind" | "arguments" | "nativeCallId" | "operationIndex"> & {
      target: "executor";
    });
type Owner = {
  authority: ActiveExecutionAuthority & { start(): void; assertActive(): void };
  storage: Promise<PublishedDurableStorage>;
  runs: Map<number, DurableSessionOpen>;
  bindings: Map<number, DurableRunBinding>;
  runtime?: Promise<ManagedNativeRuntime>;
  prepare?: (commit: DurableSessionCommit) => NativePublicationPreparation;
  display: Map<number, PrepareDisplay>;
  publicationTail: Promise<unknown>;
  releaseTail: Promise<unknown>;
  closing?: Promise<void>;
  interruption: AbortController;
  readSignal: AbortSignal;
  recoveredOperations: Map<
    number,
    { operationId: string; activationId: string; writerId: string; target: "cube" | "executor" }
  >;
};
export type DurableSessionHandle = {
  binding: DurableRunBinding;
  storage: import("@earendil-works/pi-durable").Storage;
  recordSequence(id: number): Promise<number | undefined>;
  remoteToolIntent(taskId: number, conversationId: number): Promise<OriginalRemoteToolIntent>;
  committedSequence(): number;
  authority: ActiveExecutionAuthority;
  runtime<T extends ManagedNativeRuntime>(factory: () => Promise<T>): Promise<T>;
  preparePublication(prepare: (commit: DurableSessionCommit) => NativePublicationPreparation): void;
  prepareDisplay(prepare: PrepareDisplay): void;
  serializePublication<T>(work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
  interrupt(reason: Error): void;
};

/** One storage and one Harness per physical lease incarnation. The SDK does
 * not elect distributed owners: this host opens only under PG-issued authority. */
export class PostgresDurableSessionHost {
  readonly #owners = new Map<string, Owner>();
  readonly #executions = new Map<string, Owner>();
  readonly #leases: PostgresSessionLeaseObserver;
  #closed = false;
  constructor(
    readonly options: {
      database: Kysely<Database>;
      leaseDatabase?: Kysely<Database>;
      images?: ImageAttachmentCodec;
      onReadStart?: import("./published-storage.ts").DurableStorageOptions["onReadStart"];
      restoreReplies?: (
        references: readonly PendingToolReplyRecovery[],
        signal: AbortSignal,
      ) => Promise<void>;
    },
  ) {
    this.#leases = new PostgresSessionLeaseObserver({
      database: options.leaseDatabase ?? options.database,
    });
  }
  hasExecution(reference: string): boolean {
    return this.#executions.has(reference);
  }
  /** Synchronous provider admission check: event-loop delay cannot extend a
   * confirmed deadline while its timer is still queued. This never queries PG. */
  assertExecutionCurrent(reference: string): void {
    const owner = this.#executions.get(reference);
    if (!owner) throw new NativeSessionError("storage", "Native Session owner is unavailable");
    owner.authority.assertActive();
  }
  runtimeFor(reference: string): Promise<ManagedNativeRuntime> | undefined {
    return this.#executions.get(reference)?.runtime;
  }
  async childAnchor(
    reference: string,
    inherit: boolean,
    conversationId: number,
  ): Promise<string | null> {
    const owner = this.#executions.get(reference),
      binding = owner?.runs.get(conversationId)?.binding;
    if (!owner || !binding) throw new Error("Parent native owner is unavailable");
    await owner.authority.assertCurrent();
    const runtime = await owner.runtime;
    if (!runtime?.childAnchor) throw new Error("Parent native conversation is unavailable");
    const tail = inherit ? await runtime.childAnchor(binding.conversationId) : undefined;
    return tail === undefined ? null : String(tail);
  }
  async conversationDepth(reference: string, conversationId: number): Promise<number> {
    const owner = this.#executions.get(reference);
    if (!owner) throw new Error("Native owner is unavailable");
    await owner.authority.assertCurrent();
    const storage = await owner.storage;
    let id: number | undefined = conversationId,
      depth = 0;
    const seen = new Set<number>();
    while (id !== undefined) {
      if (seen.has(id)) throw new Error("Native conversation ancestry is cyclic");
      seen.add(id);
      const conversation = await storage.conversation(
        id as import("@earendil-works/pi-durable").ConversationId,
        BACKGROUND_CONTEXT,
      );
      if (!conversation) throw new Error("Native conversation ancestry is unavailable");
      id = conversation.owner?.conversationId;
      if (id !== undefined) depth++;
    }
    return depth;
  }
  async publishControl(
    taskId: number,
    command: import("@pi-cloud/protocol").CandidateControlToolCommand,
  ): Promise<void> {
    const owner = this.#executions.get(command.executionReference);
    if (!owner) throw new Error("Native hostcall owner is unavailable");
    await owner.authority.assertCurrent();
    const runtime = await owner.runtime;
    if (!runtime?.publishControl) throw new Error("Native hostcall port is unavailable");
    await runtime.publishControl(taskId, command);
  }
  async originalControlIntent(
    reference: string,
    conversationId: number,
    taskId: number,
    signal?: AbortSignal,
  ): Promise<OriginalControlToolIntent> {
    const owner = this.#executions.get(reference);
    const binding = owner?.bindings.get(conversationId);
    if (!owner || !binding) throw new Error("Control recovery owner is unavailable");
    await owner.authority.assertCurrent();
    return nativeRead(
      async () => {
        let after = 0;
        for (;;) {
          // History is indexed by this one Task identity, never a Session journal scan.
          const rows = await sql<{ seq: string; body: string; cloud_metadata: string }>`
          select l.seq::text,l.body,c.cloud_metadata
          from pi_durable_log l join pi_durable_commits c using(tenant_id,session_id,seq)
          where l.tenant_id=${binding.tenantId}::uuid and l.session_id=${binding.piSessionId}
            and l.record_kind='task' and l.record_id=${taskId}
            and l.seq>${after} and c.cloud_metadata is not null
          order by l.seq limit 16`.execute(this.options.database);
          for (const row of rows.rows) {
            let metadata: { controlTools?: unknown[] }, write: Record<string, unknown>;
            try {
              metadata = JSON.parse(row.cloud_metadata);
              write = JSON.parse(row.body);
            } catch {
              throw new Error("Stored control recovery source is invalid");
            }
            for (const candidate of metadata.controlTools ?? []) {
              const d = parseControlToolDispatch(candidate);
              if (d.taskId !== taskId || d.sourceDocumentId !== undefined || d.recovery) continue;
              const scope = (candidate as { scope: Record<string, unknown> }).scope;
              if (
                d.toolName !== "subagent" ||
                d.conversationId !== conversationId ||
                scope?.tenantId !== binding.tenantId ||
                scope.piSessionId !== binding.piSessionId ||
                scope.runId !== binding.runId ||
                scope.sessionId !== binding.sessionId ||
                scope.turnId !== binding.turnId
              )
                throw new Error("Control recovery source belongs to different work");
              const task = write.value as { state?: { checkpoint?: { replay?: string } } };
              if (task.state?.checkpoint?.replay !== "safe")
                throw new Error("Original control intent is not replay-safe");
              const sequence = Number(row.seq);
              const intent = durableControlIntent(
                { seq: sequence, nextId: taskId + 1, writes: [write] },
                d,
              );
              return {
                sequence,
                operationId: d.operationId,
                taskId,
                conversationId,
                toolName: d.toolName,
                nativeCallId: intent.callId,
                arguments: intent.arguments,
                contextAnchor: d.contextAnchor,
              };
            }
          }
          if (rows.rows.length < 16) throw new Error("Original control intent is unavailable");
          after = Number(rows.rows.at(-1)!.seq);
        }
      },
      signal ? AbortSignal.any([owner.readSignal, signal]) : owner.readSignal,
      (error) => owner.interruption.abort(error),
    );
  }

  async originalRemoteIntent(
    reference: string,
    conversationId: number,
    taskId: number,
  ): Promise<OriginalRemoteToolIntent> {
    const owner = this.#executions.get(reference);
    const binding = owner?.bindings.get(conversationId);
    if (!owner || !binding) throw new Error("Remote recovery owner is unavailable");
    await owner.authority.assertCurrent();
    return nativeRead(
      async () => {
        const {
          rows: [row],
        } = await sql<{ seq: string; cloud_metadata: string; body: string }>`
        select c.seq::text,c.cloud_metadata,l.body
        from pi_durable_records r join pi_durable_commits c
          on c.tenant_id=r.tenant_id and c.session_id=r.session_id and c.seq=(r.fields->>'replyIntentSeq')::bigint
        join pi_durable_log l on l.tenant_id=c.tenant_id and l.session_id=c.session_id and l.seq=c.seq
          and l.record_kind='task' and l.record_id=r.id and l.phase='"execute"'
        where r.tenant_id=${binding.tenantId}::uuid and r.session_id=${binding.piSessionId}
          and r.id=${taskId} and r.kind='task' and r.fields->>'status'<>'terminal'
        order by l.ordinal limit 1`.execute(this.options.database);
        if (!row) throw new Error("Original remote Tool intent is unavailable");
        const metadata = JSON.parse(row.cloud_metadata) as { remoteTools?: RemoteToolMetadata[] };
        const source = metadata.remoteTools?.find((t) => t.taskId === taskId);
        const write = JSON.parse(row.body);
        if (
          !source ||
          source.scope?.tenantId !== binding.tenantId ||
          source.scope.piSessionId !== binding.piSessionId ||
          source.scope.runId !== binding.runId ||
          source.scope.sessionId !== binding.sessionId ||
          source.scope.turnId !== binding.turnId ||
          write.value?.conversationId !== conversationId ||
          (source.target === "cube"
            ? source.request?.operation !== "tool.execute"
            : source.target !== "executor" || source.conversationId !== conversationId)
        )
          throw new Error("Remote Tool recovery changed native work identity");
        const sequence = Number(row.seq);
        const intent = durableToolIntent(
          { seq: sequence, nextId: taskId + 1, writes: [write] },
          taskId,
        );
        const reply = parseToolReplyRecovery(source.replyRecovery);
        if (
          reply.topic !== source.replyTopic ||
          reply.toolCallId !== intent.callId ||
          reply.toolName !== (source.target === "cube" ? source.request.toolName : source.toolName)
        )
          throw new Error("Remote Tool recovery changed reply identity");
        return {
          sequence,
          taskId,
          conversationId,
          reply,
          command:
            source.target === "executor"
              ? {
                  kind: "executor_tool",
                  target: "executor",
                  scope: source.scope,
                  operationId: source.operationId,
                  bindingId: source.bindingId,
                  taskId,
                  conversationId,
                  toolName: source.toolName,
                  nativeCallId: intent.callId,
                  arguments: intent.arguments,
                  replyTopic: source.replyTopic,
                  replyRecovery: reply,
                  occurredAt: source.occurredAt,
                }
              : {
                  kind: "tool_command",
                  scope: source.scope,
                  toolCallId: `task:${taskId}`,
                  replyTopic: source.replyTopic,
                  replyRecovery: reply,
                  occurredAt: source.occurredAt,
                  ...(source.environment ? { environment: source.environment } : {}),
                  request: parseToolSandboxOperationRequest({
                    ...source.request,
                    args: intent.arguments,
                    toolCallId: intent.callId,
                  }),
                },
        };
      },
      owner.readSignal,
      (error) => owner.interruption.abort(error),
    );
  }

  async #restoreReplies(
    binding: DurableRunBinding,
    signal: AbortSignal,
    operations: Owner["recoveredOperations"],
    stopOnResume = false,
  ): Promise<void> {
    const { rows } = await sql<{ id: string; cloud_metadata: string }>`
      select r.id::text,c.cloud_metadata from pi_durable_records r
      join pi_durable_commits c on c.tenant_id=r.tenant_id and c.session_id=r.session_id
        and c.seq=(r.fields->>'replyIntentSeq')::bigint
      where r.tenant_id=${binding.tenantId}::uuid and r.session_id=${binding.piSessionId}
        and r.kind='task' and r.fields ? 'replyTopic' and r.fields->>'status'<>'terminal'
        and r.fields->>'run'=${binding.runId}
      order by r.id`.execute(this.options.database);
    const references = rows.map((row) => {
      const metadata = JSON.parse(row.cloud_metadata) as { remoteTools?: RemoteToolMetadata[] };
      const source = metadata.remoteTools?.find((t) => t.taskId === Number(row.id));
      if (
        !source ||
        source.scope?.tenantId !== binding.tenantId ||
        source.scope.piSessionId !== binding.piSessionId ||
        source.scope.runId !== binding.runId
      )
        throw new Error("Pending Tool replay scope changed");
      if (source.target !== "cube" && source.target !== "executor")
        throw new Error("Pending Tool recovery target changed");
      const operationId =
        source.target === "cube" ? source.request.operationId : source.operationId;
      operations.set(Number(row.id), {
        operationId,
        activationId: source.target === "cube" ? source.request.activationId : source.bindingId,
        writerId: source.scope.writerId,
        target: source.target,
      });
      return { operationId, reply: parseToolReplyRecovery(source.replyRecovery) };
    });
    if (!stopOnResume && references.length) {
      if (!this.options.restoreReplies)
        throw new Error("Remote Tool reply recovery is not configured");
      await this.options.restoreReplies(references, signal);
    }
  }
  async retireHostCall(reference: string, taskId: number, id: string): Promise<void> {
    const owner = this.#executions.get(reference);
    if (!owner) return;
    await owner.authority.assertCurrent();
    await (await owner.runtime)?.retireHostCall?.(taskId, id);
  }
  async createChildConversation(input: {
    executionReference: string;
    requestId: string;
    ownerTaskId: number;
    parentConversationId: number;
    at: string | null;
    view?: ConversationWorkView;
  }): Promise<number> {
    const owner = this.#executions.get(input.executionReference),
      binding = owner?.runs.get(input.parentConversationId)?.binding;
    if (!owner || !binding) throw new Error("Parent native owner is unavailable");
    await owner.authority.assertCurrent();
    const runtime = await owner.runtime;
    if (!runtime?.createConversation) throw new Error("Parent native conversation is unavailable");
    return runtime.createConversation({
      requestId: input.requestId,
      ownerTaskId: input.ownerTaskId,
      parentConversationId: binding.conversationId,
      ...(input.at === null ? {} : { at: Number(input.at) }),
      ...(input.view ? { view: input.view } : {}),
    });
  }
  async stopConversation(reference: string, requestId: string): Promise<void> {
    const owner = this.#executions.get(reference);
    if (!owner) throw new Error("Native owner is unavailable");
    await owner.authority.assertCurrent();
    const runtime = await owner.runtime;
    if (!runtime?.stopConversation) throw new Error("Native cancellation port is unavailable");
    await runtime.stopConversation(requestId);
  }
  async inputReceipt(
    reference: string,
    conversationId: number,
    requestId: string,
  ): Promise<boolean> {
    const owner = this.#executions.get(reference);
    if (!owner) throw new Error("Native owner is unavailable");
    await owner.authority.assertCurrent();
    const receipt = await (
      await owner.storage
    ).submissionByRequest(
      conversationId as import("@earendil-works/pi-durable").ConversationId,
      requestId,
      BACKGROUND_CONTEXT,
    );
    // This acknowledges durable admission, not processing. A later abort can
    // withdraw an admitted input without making the original ACK untrue.
    return !!receipt;
  }
  async activeConversations(reference: string): Promise<
    Array<{
      conversationId: number;
      view: ConversationWorkView;
      nextEventSeq: number;
    }>
  > {
    const owner = this.#executions.get(reference);
    if (!owner) throw new Error("Native owner is unavailable");
    await owner.authority.assertCurrent();
    const binding = owner.runs.values().next().value!.binding;
    const views = (await (await owner.runtime)?.activeConversationViews?.(binding.runId)) ?? [];
    return nativeRead(
      async () => {
        const result: Array<{
          conversationId: number;
          view: ConversationWorkView;
          nextEventSeq: number;
        }> = [];
        for (let first = 0; first < views.length; first += 128) {
          const batch = views.slice(first, first + 128);
          const rows = await this.options.database
            .selectFrom("subagent_conversations as v")
            .innerJoin("sessions as s", (join) =>
              join
                .onRef("s.id", "=", "v.child_session_id")
                .onRef("s.tenant_id", "=", "v.tenant_id"),
            )
            .select([
              "v.id",
              "v.child_session_id",
              "v.child_turn_id",
              "v.source_sequence",
              "v.source_record_id",
              "v.source_kind",
              "s.pi_conversation_id",
              sql<string>`greatest(s.next_event_seq,v.output_display_seq+1)`.as("next"),
            ])
            .where("v.tenant_id", "=", binding.tenantId)
            .where("v.root_run_id", "=", binding.runId)
            .where("v.root_session_id", "=", binding.sessionId)
            .where("s.pi_session_id", "=", binding.piSessionId)
            .where(
              "v.id",
              "in",
              batch.map((entry) => entry.view.id),
            )
            .execute();
          const byId = new Map(rows.map((row) => [row.id, row]));
          for (const entry of batch) {
            const row = byId.get(entry.view.id),
              source = entry.view.source;
            if (
              !row ||
              row.child_session_id !== entry.view.sessionId ||
              row.child_turn_id !== entry.view.turnId ||
              Number(row.source_sequence) !== source.sequence ||
              Number(row.source_record_id) !== (source.documentId ?? source.taskId) ||
              row.source_kind !== (source.documentId === undefined ? "task" : "document.create") ||
              (row.pi_conversation_id !== null &&
                Number(row.pi_conversation_id) !== entry.conversationId)
            )
              throw new Error("Native child view is missing or changed");
            result.push({ ...entry, nextEventSeq: Number(row.next) });
          }
        }
        return result;
      },
      owner.readSignal,
      (error) => owner.interruption.abort(error),
    );
  }

  observeLeaseRenewals(
    heartbeat: SupervisorHeartbeatMessage,
    ack: SupervisorHeartbeatAckMessage,
    requestedAt: number,
  ): void {
    this.#leases.observeRenewals(heartbeat, ack, requestedAt);
  }
  async open(input: DurableSessionOpen): Promise<DurableSessionHandle> {
    if (this.#closed) throw new Error("Native Session host is closed");
    input.signal?.throwIfAborted();
    const binding = input.binding,
      identity = parseExecutionReference(binding.executionReference);
    if (
      identity.leaseId !== binding.writerId ||
      identity.runId !== binding.runId ||
      !Number.isSafeInteger(binding.conversationId) ||
      binding.conversationId < 1
    )
      throw new Error("Native Session binding does not match its execution grant");
    const key = JSON.stringify([
      binding.tenantId,
      binding.piSessionId,
      identity.leaseId,
      identity.fencingToken,
    ]);
    let owner = this.#owners.get(key);
    if (owner?.closing) {
      await owner.closing;
      owner = undefined;
    }
    if (!owner) {
      const lease = this.#leases.open({
        tenantId: binding.tenantId,
        piSessionId: binding.piSessionId,
        leaseId: identity.leaseId,
        writerId: binding.writerId,
        fencingToken: identity.fencingToken,
      });
      const interruption = new AbortController();
      const authority = {
        signal: AbortSignal.any([
          lease.signal,
          interruption.signal,
          ...(input.signal ? [input.signal] : []),
        ]),
        assertCurrent: async () => {
          input.signal?.throwIfAborted();
          interruption.signal.throwIfAborted();
          await lease.assertCurrent();
        },
        assertActive: () => {
          input.signal?.throwIfAborted();
          interruption.signal.throwIfAborted();
          lease.assertActive();
        },
        start: () => lease.start(),
        close: () => lease.close(),
      };
      const readSignal = authority.signal;
      const readFailed = (error: Error) => interruption.abort(error);
      const projection = new DurablePostgresProjection(
        this.options.database,
        { tenantId: binding.tenantId, sessionId: binding.piSessionId },
        this.options.images,
      );
      const runs = new Map<number, DurableSessionOpen>(),
        bindings = new Map<number, DurableRunBinding>();
      const recoveredOperations: Owner["recoveredOperations"] = new Map();
      const progress = new NativeProjectionProgress({
        initialThrough: 0,
        assertCurrent: () => authority.assertCurrent(),
        read: () => nativeRead(async () => (await projection.head()).seq, readSignal, readFailed),
      });
      const storage = (async () => {
        await authority.assertCurrent();
        // Watch ownership while the cold head is still loading, not only after
        // it returns. The separate lease pool can revoke a blocked data read.
        authority.start();
        const store = await PublishedDurableStorage.open({
          projection,
          ...(this.options.onReadStart ? { onReadStart: this.options.onReadStart } : {}),
          signal: readSignal,
          onReadFailure: readFailed,
          assertCurrent: () => authority.assertCurrent(),
          publish: (batch, inputConversations = [], documents = []) =>
            this.#serialize(this.#owners.get(key)!, async () => {
              await authority.assertCurrent();
              const active = runs.values().next().value as DurableSessionOpen | undefined;
              if (!active)
                throw new PublicationNotSentError(
                  "Native Session has no admitted publication anchor",
                );
              const commit = batch as unknown as DurableSessionCommit;
              const preparation = this.#owners.get(key)?.prepare?.(commit);
              const recoveryCancellations: import("@pi-cloud/protocol").CandidateToolCancellation[] =
                [];
              const completedRecoveries: number[] = [];
              for (const write of commit.writes) {
                if (write.type !== "task") continue;
                const task = durableToolState(write.value);
                const original = task && recoveredOperations.get(task.id);
                if (!task || !original) continue;
                if (task.aborted)
                  recoveryCancellations.push({
                    executionReference: active.binding.executionReference,
                    conversationId: active.binding.conversationId,
                    activationId: original.activationId,
                    operationId: original.operationId,
                    originalWriterId: original.writerId,
                    ...(original.target === "executor" ? { target: "executor" as const } : {}),
                  });
                if (task.terminal) completedRecoveries.push(task.id);
              }
              const display = [...this.#owners.get(key)!.display].map(
                ([conversationId, prepare]) => ({
                  executionReference: bindings.get(conversationId)!.executionReference,
                  conversationId,
                  prepared: prepare(commit, documents),
                }),
              );
              const origins = batch.writes.flatMap((write) => {
                if (!("value" in write) || !("conversationId" in write.value)) return [];
                const origin = bindings.get(write.value.conversationId);
                return origin
                  ? [
                      {
                        recordId: write.value.id,
                        sessionId: origin.sessionId,
                        turnId: origin.turnId,
                        runId: origin.runId,
                      },
                    ]
                  : [];
              });
              let acknowledged = false;
              try {
                await active.publish({
                  commit,
                  origins,
                  ...(inputConversations.length
                    ? {
                        inputQueueSessions: [
                          ...new Set(
                            inputConversations.flatMap((id) => {
                              const binding = bindings.get(id);
                              return binding ? [binding.sessionId] : [];
                            }),
                          ),
                        ],
                      }
                    : {}),
                  tools: preparation?.tools ?? [],
                  cancellations: [
                    ...new Map(
                      [...(preparation?.cancellations ?? []), ...recoveryCancellations].map(
                        (cancel) => [cancel.operationId, cancel],
                      ),
                    ).values(),
                  ],
                  display: display.flatMap(({ executionReference, conversationId, prepared }) =>
                    prepared.events.length || prepared.coveredThrough !== undefined
                      ? [
                          {
                            executionReference,
                            conversationId,
                            events: prepared.events,
                            ...(prepared.coveredThrough === undefined
                              ? {}
                              : { coveredThrough: prepared.coveredThrough }),
                          },
                        ]
                      : [],
                  ),
                });
                acknowledged = true;
                preparation?.confirmed();
                for (const id of completedRecoveries) recoveredOperations.delete(id);
                for (const { prepared } of display) prepared.confirmed();
              } catch (cause) {
                if (!acknowledged && cause instanceof PublicationNotSentError) {
                  // Native fault settlement can itself be refused. Give Kafka
                  // ACKs and lease timers an IO turn before Pi handles the error;
                  // do not resubmit the batch or wait for queue capacity here.
                  await yieldToIo();
                  throw cause;
                }
                const failure = Object.assign(
                  new Error(
                    acknowledged
                      ? "Native Session acknowledgement adoption failed"
                      : "Native Session publication failed",
                    { cause },
                  ),
                  { code: "writer_publication_failed" },
                );
                interruption.abort(failure);
                // Even a typed no-send exception after ACK is now uncertain to
                // native memory. Never let Storage treat it as a rejected draft.
                throw failure;
              }
            }),
          waitProjected: (through) => progress.wait(through, authority.signal),
        });
        await this.#restoreReplies(binding, readSignal, recoveredOperations, input.stopOnResume);
        return store;
      })();
      owner = {
        authority,
        storage,
        runs,
        bindings,
        interruption,
        readSignal,
        recoveredOperations,
        display: new Map(),
        publicationTail: Promise.resolve(),
        releaseTail: Promise.resolve(),
      };
      this.#owners.set(key, owner);
    }
    const currentOwner = owner;
    if (owner.runs.has(binding.conversationId))
      throw new Error("Conversation is already attached to the native Session");
    owner.runs.set(binding.conversationId, input);
    owner.bindings.set(binding.conversationId, binding);
    this.#executions.set(binding.executionReference, owner);
    let releasing: Promise<void> | undefined;
    const release = (): Promise<void> => {
      if (releasing) return releasing;
      releasing = currentOwner.releaseTail.then(async () => {
        // Keep the final anchor installed through Harness.close(), so queued
        // native cleanup commits still use the current, unsealed identity.
        try {
          if (currentOwner.runs.size === 1) await this.#closeOwner(key, currentOwner);
          await currentOwner.publicationTail;
        } finally {
          currentOwner.display.delete(binding.conversationId);
          currentOwner.runs.delete(binding.conversationId);
          if (
            ![...currentOwner.runs.values()].some(
              (run) => run.binding.executionReference === binding.executionReference,
            )
          )
            this.#executions.delete(binding.executionReference);
        }
      });
      currentOwner.releaseTail = releasing.catch(() => {});
      return releasing;
    };
    try {
      const storage = await owner.storage;
      await owner.authority.assertCurrent();
      return {
        binding,
        storage,
        recordSequence: (id) => storage.recordSequence(id),
        remoteToolIntent: (taskId, conversationId) =>
          this.originalRemoteIntent(binding.executionReference, conversationId, taskId),
        committedSequence: () => storage.committedSequence,
        authority: owner.authority,
        runtime: <T extends ManagedNativeRuntime>(factory: () => Promise<T>): Promise<T> => {
          if (!currentOwner.runtime) currentOwner.runtime = factory();
          return currentOwner.runtime as Promise<T>;
        },
        preparePublication: (prepare) => {
          currentOwner.prepare = prepare;
        },
        prepareDisplay: (prepare) => {
          currentOwner.display.set(binding.conversationId, prepare);
        },
        serializePublication: (work) => this.#serialize(currentOwner, work),
        close: release,
        interrupt: (reason) => {
          currentOwner.interruption.abort(reason);
        },
      };
    } catch (error) {
      // Before open returns, the Runner has no handle from which to recover
      // the authority failure. Capture it before release closes that authority;
      // a corrupt head must not become a recoverable lease error during cleanup.
      const revoked = owner.authority.signal.aborted;
      const reason: unknown = owner.authority.signal.reason;
      const reasonCode = reason instanceof Error ? (reason as { code?: string }).code : undefined;
      const code = [
        "native_storage_unavailable",
        "writer_publication_failed",
        "worker_shutdown",
      ].includes(reasonCode ?? "")
        ? reasonCode
        : reason instanceof NativeSessionError && reason.code === "storage"
          ? "session_lease_revoked"
          : isTransientDatabaseReadError(reason)
            ? "native_storage_unavailable"
            : undefined;
      const failure =
        revoked && code
          ? Object.assign(
              new Error("Native Session opening lost its execution authority", { cause: error }),
              { code, retryable: true },
            )
          : error;
      await release().catch(() => {});
      throw failure;
    }
  }
  #serialize<T>(owner: Owner, work: () => Promise<T>): Promise<T> {
    const next = owner.publicationTail.then(work);
    owner.publicationTail = next.catch(() => undefined);
    return next;
  }
  #closeOwner(key: string, owner: Owner): Promise<void> {
    if (!owner.closing)
      owner.closing = (async () => {
        try {
          await (await owner.runtime)?.close();
        } finally {
          try {
            const storage = await owner.storage;
            await storage.close(BACKGROUND_CONTEXT);
          } finally {
            await owner.authority.close();
            if (this.#owners.get(key) === owner) this.#owners.delete(key);
          }
        }
      })();
    return owner.closing;
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const owner of this.#owners.values())
      owner.interruption.abort(
        Object.assign(new Error("Native Session host is retiring"), {
          code: "worker_shutdown",
          retryable: true,
        }),
      );
    const results = await Promise.allSettled(
      [...this.#owners].map(([key, owner]) => this.#closeOwner(key, owner)),
    );
    this.#executions.clear();
    await this.#leases.close();
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Native Session shutdown failed");
  }
}
