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
import { PublishedDurableStorage } from "./published-storage.ts";

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
export type ManagedNativeRuntime = {
  close(): Promise<void>;
  childAnchor?(conversationId: number): Promise<number | undefined>;
  createConversation?(input: {
    requestId: string;
    ownerTaskId: number;
    parentConversationId: number;
    at?: number;
  }): Promise<number>;
};
type Owner = {
  authority: ActiveExecutionAuthority & { start(): void };
  storage: Promise<PublishedDurableStorage>;
  runs: Map<string, DurableSessionOpen>;
  bindings: Map<number, DurableRunBinding>;
  runtime?: Promise<ManagedNativeRuntime>;
  prepare?: (commit: DurableSessionCommit) => NativePublicationPreparation;
  closing?: Promise<void>;
  interruption: AbortController;
};
export type DurableSessionHandle = {
  binding: DurableRunBinding;
  storage: import("@earendil-works/pi-durable").Storage;
  recordSequence(id: number): Promise<number | undefined>;
  authority: ActiveExecutionAuthority;
  runtime<T extends ManagedNativeRuntime>(factory: () => Promise<T>): Promise<T>;
  preparePublication(prepare: (commit: DurableSessionCommit) => NativePublicationPreparation): void;
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
  async childAnchor(reference: string, inherit: boolean): Promise<string | null> {
    const owner = this.#executions.get(reference),
      binding = owner?.runs.get(reference)?.binding;
    if (!owner || !binding) throw new Error("Parent native owner is unavailable");
    await owner.authority.assertCurrent();
    const runtime = await owner.runtime;
    if (!runtime?.childAnchor) throw new Error("Parent native conversation is unavailable");
    const tail = inherit ? await runtime.childAnchor(binding.conversationId) : undefined;
    return tail === undefined ? null : String(tail);
  }
  async createChildConversation(input: {
    executionReference: string;
    requestId: string;
    ownerTaskId: number;
    at: string | null;
  }): Promise<number> {
    const owner = this.#executions.get(input.executionReference),
      binding = owner?.runs.get(input.executionReference)?.binding;
    if (!owner || !binding) throw new Error("Parent native owner is unavailable");
    await owner.authority.assertCurrent();
    const runtime = await owner.runtime;
    if (!runtime?.createConversation) throw new Error("Parent native conversation is unavailable");
    return runtime.createConversation({
      requestId: input.requestId,
      ownerTaskId: input.ownerTaskId,
      parentConversationId: binding.conversationId,
      ...(input.at === null ? {} : { at: Number(input.at) }),
    });
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
      const runs = new Map<string, DurableSessionOpen>(),
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
          publish: async (batch) => {
            await authority.assertCurrent();
            const active = runs.values().next().value as DurableSessionOpen | undefined;
            if (!active)
              throw new PublicationNotSentError(
                "Native Session has no admitted publication anchor",
              );
            const commit = batch as unknown as DurableSessionCommit;
            const preparation = this.#owners.get(key)?.prepare?.(commit);
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
            await active.publish({
              commit,
              origins,
              tools: preparation?.tools ?? [],
              cancellations: preparation?.cancellations ?? [],
              events: [],
            });
            preparation?.confirmed();
          },
          waitProjected: (through) => progress.wait(through, authority.signal),
        });
        authority.start();
        return store;
      })();
      owner = { authority, storage, runs, bindings, interruption };
      this.#owners.set(key, owner);
    }
    const currentOwner = owner;
    if (owner.runs.has(binding.executionReference))
      throw new Error("Execution is already attached to the native Session");
    owner.runs.set(binding.executionReference, input);
    owner.bindings.set(binding.conversationId, binding);
    this.#executions.set(binding.executionReference, owner);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      this.#executions.delete(binding.executionReference);
      // Keep the final anchor installed through Harness.close(), so queued
      // native cleanup commits still use the current, unsealed identity.
      if (currentOwner.runs.size === 1) await this.#closeOwner(key, currentOwner);
      currentOwner.runs.delete(binding.executionReference);
    };
    try {
      const storage = await owner.storage;
      await owner.authority.assertCurrent();
      return {
        binding,
        storage,
        recordSequence: (id) => storage.recordSequence(id),
        authority: owner.authority,
        runtime: <T extends ManagedNativeRuntime>(factory: () => Promise<T>): Promise<T> => {
          if (!currentOwner.runtime) currentOwner.runtime = factory();
          return currentOwner.runtime as Promise<T>;
        },
        preparePublication: (prepare) => {
          currentOwner.prepare = prepare;
        },
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
