import { NativeProjectionProgress } from "../native-projection-progress.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  parseExecutionReference,
  PublicationNotSentError,
  type SupervisorHeartbeatMessage,
  type SupervisorHeartbeatAckMessage,
  type DurableCommitPublication,
  type DurableSessionCommit,
} from "@pi-cloud/protocol";
import type { ImageAttachmentCodec } from "@pi-cloud/session-attachments";
import type { ActiveExecutionAuthority } from "../execution-authority.ts";
import { PostgresSessionLeaseObserver } from "../postgres-session-lease-observer.ts";
import { DurablePostgresProjection } from "./postgres-projection.ts";
import { PublishedDurableStorage, type NativeDocumentChange } from "./published-storage.ts";
import { sql } from "kysely";
import {
  durableControlIntent,
  prepareSubagentArguments,
  type ConversationWorkView,
} from "@pi-cloud/protocol";

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
  publishHostCall?(
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
type Owner = {
  authority: ActiveExecutionAuthority & { start(): void };
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
};
export type DurableSessionHandle = {
  binding: DurableRunBinding;
  storage: import("@earendil-works/pi-durable").Storage;
  recordSequence(id: number): Promise<number | undefined>;
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
  constructor(readonly options: { database: Kysely<Database>; images?: ImageAttachmentCodec }) {
    this.#leases = new PostgresSessionLeaseObserver({ database: options.database });
  }
  hasExecution(reference: string): boolean {
    return this.#executions.has(reference);
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
  async publishHostCall(
    taskId: number,
    command: import("@pi-cloud/protocol").CandidateControlToolCommand,
  ): Promise<void> {
    const owner = this.#executions.get(command.executionReference);
    if (!owner) throw new Error("Native hostcall owner is unavailable");
    await owner.authority.assertCurrent();
    const runtime = await owner.runtime;
    if (!runtime?.publishHostCall) throw new Error("Native hostcall port is unavailable");
    await runtime.publishHostCall(taskId, command);
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
      prompt: string;
      nextEventSeq: number;
    }>
  > {
    const owner = this.#executions.get(reference);
    if (!owner) throw new Error("Native owner is unavailable");
    await owner.authority.assertCurrent();
    const binding = owner.runs.values().next().value!.binding;
    const views = (await (await owner.runtime)?.activeConversationViews?.(binding.runId)) ?? [];
    return Promise.all(
      views.map(async (entry) => {
        const { source } = entry.view;
        const record = await sql<{ body: string }>`select body from pi_durable_log
        where tenant_id=${binding.tenantId}::uuid and session_id=${binding.piSessionId}
          and seq=${source.sequence} and record_id=${source.documentId ?? source.taskId}
          and record_kind=${source.documentId === undefined ? "task" : "document.create"}`.execute(
          this.options.database,
        );
        if (record.rows.length !== 1) throw new Error("Native child source is missing");
        const intent = durableControlIntent(
          { seq: source.sequence, nextId: 2, writes: [JSON.parse(record.rows[0]!.body)] },
          {
            taskId: source.taskId,
            ...(source.documentId ? { sourceDocumentId: source.documentId } : {}),
            operationId: entry.view.id,
            conversationId: entry.view.parentConversationId,
            toolName: "subagent",
          },
        );
        const args = prepareSubagentArguments(intent.arguments);
        if (args.action !== "run") throw new Error("Native child source is not a delegation");
        const cursor = await this.options.database
          .selectFrom("sessions as s")
          .innerJoin("subagent_conversations as v", "v.child_session_id", "s.id")
          .select(sql<string>`greatest(s.next_event_seq,v.output_display_seq+1)`.as("next"))
          .where("s.tenant_id", "=", binding.tenantId)
          .where("s.id", "=", entry.view.sessionId)
          .where("v.root_run_id", "=", binding.runId)
          .executeTakeFirstOrThrow();
        return { ...entry, prompt: args.task, nextEventSeq: Number(cursor.next) };
      }),
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
        signal: AbortSignal.any([lease.signal, interruption.signal]),
        assertCurrent: async () => {
          interruption.signal.throwIfAborted();
          await lease.assertCurrent();
        },
        start: () => lease.start(),
        close: () => lease.close(),
      };
      const projection = new DurablePostgresProjection(
        this.options.database,
        { tenantId: binding.tenantId, sessionId: binding.piSessionId },
        this.options.images,
      );
      const runs = new Map<number, DurableSessionOpen>(),
        bindings = new Map<number, DurableRunBinding>();
      const progress = new NativeProjectionProgress({
        initialThrough: 0,
        assertCurrent: () => authority.assertCurrent(),
        read: async () => (await projection.head()).seq,
      });
      const storage = (async () => {
        await authority.assertCurrent();
        const store = await PublishedDurableStorage.open({
          projection,
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
              await active
                .publish({
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
                  cancellations: preparation?.cancellations ?? [],
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
                })
                .catch((cause) => {
                  interruption.abort(
                    Object.assign(new Error("Native Session publication failed", { cause }), {
                      code: "writer_publication_failed",
                    }),
                  );
                  throw cause;
                });
              preparation?.confirmed();
              for (const { prepared } of display) prepared.confirmed();
            }),
          waitProjected: (through) => progress.wait(through, authority.signal),
        });
        authority.start();
        return store;
      })();
      owner = {
        authority,
        storage,
        runs,
        bindings,
        interruption,
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
      await release();
      throw error;
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
