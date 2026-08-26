import type { Database } from "@pi-cloud/database";
import {
  PostgresPiSessionStorage,
  type PiSessionMutationOperation,
  type PiSessionMutationPublisher,
} from "@pi-cloud/pi-session-postgres";
import {
  SessionError,
  type Entry,
  type LaneRecord,
  type NewRecord,
  type ProvisionedEntry,
} from "@earendil-works/pi-agent-core";
import { AckPolicy, DeliverPolicy, type ConsumerMessages } from "@nats-io/jetstream";
import type { Kysely } from "kysely";
import {
  PI_SESSION_MUTATION_STREAM_NAME,
  PI_SESSION_MUTATION_SUBJECT_PREFIX,
  piSessionMutationSubject,
  type PiCloudJetStream,
} from "./jetstream-runtime.ts";
import type { ActiveFactChannelResolver, CandidatePiSessionMutationFact } from "./accepted-fact.ts";

export const PI_SESSION_MUTATION_PROJECTOR_CONSUMER = "PI_CLOUD_SESSION_PROJECTOR";

export type JetStreamPiSessionMutationScope = Readonly<{
  tenantId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  executionGrant: string;
}>;

export type PiSessionMutationRequest = CandidatePiSessionMutationFact;

export type AcceptedPiSessionMutationEnvelope = Readonly<{
  schemaVersion: 2;
  mutationId: string;
  scope: Readonly<{
    tenantId: string;
    sessionId: string;
    turnId: string;
    runId: string;
    executionId: string;
  }>;
  operation: PiSessionMutationOperation;
  occurredAt: string;
}>;

function object(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${description} is invalid`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, description: string, maximum = 4_096): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new TypeError(`${description} is invalid`);
  }
  return value;
}

function uuid(value: unknown, description: string): string {
  const candidate = string(value, description, 64);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate)
  ) {
    throw new TypeError(`${description} is invalid`);
  }
  return candidate;
}

function parseOperation(value: unknown): PiSessionMutationOperation {
  const candidate = object(value, "Pi Session mutation operation");
  switch (candidate.kind) {
    case "create_lane":
      return {
        kind: "create_lane",
        lane: string(candidate.lane, "Pi lane", 256),
        at: candidate.at === null ? null : string(candidate.at, "Pi lane target", 512),
      };
    case "move_lane":
      return {
        kind: "move_lane",
        lane: string(candidate.lane, "Pi lane", 256),
        to: candidate.to === null ? null : string(candidate.to, "Pi lane target", 512),
      };
    case "append_entry":
      return {
        kind: "append_entry",
        entry: structuredClone(object(candidate.entry, "Pi entry")) as ProvisionedEntry<Entry>,
        lane: string(candidate.lane, "Pi entry lane", 256),
      };
    case "append_record":
      return {
        kind: "append_record",
        record: structuredClone(object(candidate.record, "Pi record")) as NewRecord<LaneRecord>,
      };
    case "set_name":
      return { kind: "set_name", name: string(candidate.name, "Pi Session name", 1_024) };
    case "set_label":
      return {
        kind: "set_label",
        id: string(candidate.id, "Pi label target", 512),
        ...(candidate.label === undefined
          ? {}
          : { label: string(candidate.label, "Pi label", 1_024) }),
      };
    case "projection_barrier":
      return { kind: "projection_barrier" };
    default:
      throw new TypeError("Pi Session mutation kind is invalid");
  }
}

export function parseAcceptedPiSessionMutationEnvelope(
  value: Uint8Array | Buffer | string,
): AcceptedPiSessionMutationEnvelope {
  const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  const candidate = object(JSON.parse(text) as unknown, "accepted Pi Session mutation envelope");
  const scope = object(candidate.scope, "accepted Pi Session mutation scope");
  const occurredAt = string(candidate.occurredAt, "Pi Session mutation timestamp", 64);
  if (candidate.schemaVersion !== 2 || Number.isNaN(new Date(occurredAt).valueOf())) {
    throw new TypeError("Accepted Pi Session mutation envelope is invalid");
  }
  return {
    schemaVersion: 2,
    mutationId: uuid(candidate.mutationId, "Pi Session mutation ID"),
    scope: {
      tenantId: uuid(scope.tenantId, "tenant ID"),
      sessionId: string(scope.sessionId, "Session ID", 512),
      turnId: uuid(scope.turnId, "Turn ID"),
      runId: uuid(scope.runId, "Run ID"),
      executionId: uuid(scope.executionId, "Run execution ID"),
    },
    operation: parseOperation(candidate.operation),
    occurredAt,
  };
}

export class JetStreamAcceptedPiSessionMutationPublisher {
  readonly #runtime: PiCloudJetStream;

  constructor(runtime: PiCloudJetStream) {
    this.#runtime = runtime;
  }

  async append(envelope: AcceptedPiSessionMutationEnvelope): Promise<void> {
    await this.#runtime.client.publish(
      piSessionMutationSubject(envelope.scope.sessionId),
      new TextEncoder().encode(JSON.stringify(envelope)),
      {
        msgID: envelope.mutationId,
        expect: { streamName: PI_SESSION_MUTATION_STREAM_NAME },
        timeout: 10_000,
      },
    );
  }

  async checkHealth(): Promise<void> {
    await this.#runtime.manager.streams.info(PI_SESSION_MUTATION_STREAM_NAME);
  }
}

export class FactChannelPiSessionMutationProducer {
  readonly #database: Kysely<Database>;
  readonly #channels: ActiveFactChannelResolver;
  #closed = false;

  constructor(options: { database: Kysely<Database>; channels: ActiveFactChannelResolver }) {
    this.#database = options.database;
    this.#channels = options.channels;
  }

  scoped(scope: JetStreamPiSessionMutationScope): PiSessionMutationPublisher {
    return {
      mutate: (operation) => this.#mutate(scope, operation),
      synchronize: async () => {
        await this.#mutate(scope, { kind: "projection_barrier" });
      },
    };
  }

  async checkHealth(): Promise<void> {
    if (this.#closed) throw new Error("Pi Session mutation producer is closed");
    await this.#channels.checkHealth();
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  async #mutate(scope: JetStreamPiSessionMutationScope, operation: PiSessionMutationOperation) {
    if (this.#closed) throw new Error("Pi Session mutation producer is closed");
    const mutationId = globalThis.crypto.randomUUID();
    const request: PiSessionMutationRequest = {
      schemaVersion: 1,
      mutationId,
      scope,
      operation,
      occurredAt: new Date().toISOString(),
    };
    const deadline = Date.now() + 120_000;
    let accepted = false;
    let nextSubmitAt = 0;
    let retryDelayMs = 100;
    while (true) {
      const result = await this.#result(scope, mutationId);
      if (result?.state === "completed") return structuredClone(result.result);
      if (result?.state === "failed") {
        throw new SessionError(
          "storage",
          `${result.error_code ?? "storage"}: ${result.error_message ?? "Pi Session mutation failed"}`,
        );
      }
      if (Date.now() >= deadline) throw new Error("Pi Session mutation projection timed out");
      if (!accepted && Date.now() >= nextSubmitAt) {
        const channel = this.#channels.resolve(scope.executionGrant);
        const outcome = await channel?.mutate(request).catch(() => undefined);
        if (outcome?.accepted === true && outcome.mutationId === mutationId) {
          accepted = true;
        } else {
          nextSubmitAt = Date.now() + retryDelayMs;
          retryDelayMs = Math.min(1_000, retryDelayMs * 2);
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  #result(scope: JetStreamPiSessionMutationScope, mutationId: string) {
    return this.#database
      .selectFrom("pi_session_mutation_results")
      .select(["state", "result", "error_code", "error_message"])
      .where("mutation_id", "=", mutationId)
      .where("tenant_id", "=", scope.tenantId)
      .where("session_id", "=", scope.sessionId)
      .executeTakeFirst();
  }
}

export class JetStreamPiSessionMutationProjector {
  readonly #database: Kysely<Database>;
  readonly #runtime: PiCloudJetStream;
  #messages: ConsumerMessages | undefined;
  #run: Promise<void> | undefined;
  #failure: unknown;
  #projectedSinceCleanup = 0;

  constructor(options: { database: Kysely<Database>; runtime: PiCloudJetStream }) {
    this.#database = options.database;
    this.#runtime = options.runtime;
  }

  async start(): Promise<void> {
    const durableName = PI_SESSION_MUTATION_PROJECTOR_CONSUMER;
    try {
      await this.#runtime.manager.consumers.info(PI_SESSION_MUTATION_STREAM_NAME, durableName);
    } catch {
      await this.#runtime.manager.consumers.add(PI_SESSION_MUTATION_STREAM_NAME, {
        durable_name: durableName,
        ack_policy: AckPolicy.Explicit,
        ack_wait: 60 * 1_000_000_000,
        deliver_policy: DeliverPolicy.All,
        filter_subject: `${PI_SESSION_MUTATION_SUBJECT_PREFIX}.>`,
        max_ack_pending: 20_000,
      });
    }
    const consumer = await this.#runtime.client.consumers.get(
      PI_SESSION_MUTATION_STREAM_NAME,
      durableName,
    );
    this.#messages = await consumer.consume();
    this.#run = this.#consume(this.#messages).catch((error: unknown) => {
      this.#failure = error;
    });
  }

  checkHealth(): void {
    if (this.#run === undefined || this.#failure !== undefined) {
      throw new Error("Pi Session mutation projector is unhealthy");
    }
  }

  async close(): Promise<void> {
    await this.#messages?.close().catch(() => undefined);
    await this.#run;
    this.#messages = undefined;
    this.#run = undefined;
  }

  async #consume(messages: ConsumerMessages): Promise<void> {
    for await (const message of messages) {
      await this.#project(parseAcceptedPiSessionMutationEnvelope(message.data));
      message.ack();
    }
  }

  async #project(envelope: AcceptedPiSessionMutationEnvelope): Promise<void> {
    this.#projectedSinceCleanup += 1;
    if (this.#projectedSinceCleanup >= 256) {
      this.#projectedSinceCleanup = 0;
      await this.#database
        .deleteFrom("pi_session_mutation_results")
        .where("expires_at", "<", new Date())
        .execute();
    }
    const existing = await this.#database
      .selectFrom("pi_session_mutation_results")
      .select("mutation_id")
      .where("mutation_id", "=", envelope.mutationId)
      .executeTakeFirst();
    if (existing !== undefined) return;
    const storage = new PostgresPiSessionStorage({
      database: this.#database,
      tenantId: envelope.scope.tenantId,
      sessionId: envelope.scope.sessionId,
      turnId: envelope.scope.turnId,
      projectedMutationId: envelope.mutationId,
    });
    try {
      const result =
        envelope.operation.kind === "projection_barrier"
          ? { kind: "projection_barrier" as const }
          : await applyOperation(storage, envelope.operation);
      await this.#recordResult(envelope, "completed", result ?? null);
    } catch (error: unknown) {
      if (!(error instanceof SessionError)) throw error;
      await this.#recordResult(envelope, "failed", null, error);
    }
  }

  async #recordResult(
    envelope: AcceptedPiSessionMutationEnvelope,
    state: "completed" | "failed",
    result: Record<string, unknown> | Entry | LaneRecord | null,
    error?: SessionError,
  ): Promise<void> {
    await this.#database
      .insertInto("pi_session_mutation_results")
      .values({
        mutation_id: envelope.mutationId,
        tenant_id: envelope.scope.tenantId,
        session_id: envelope.scope.sessionId,
        run_id: envelope.scope.runId,
        attempt_id: envelope.scope.executionId,
        state,
        result: result as Record<string, unknown> | null,
        error_code: error?.code ?? null,
        error_message: error?.message ?? null,
        expires_at: new Date(Date.now() + 60 * 60_000),
      })
      .onConflict((conflict) => conflict.column("mutation_id").doNothing())
      .executeTakeFirst();
  }
}

async function applyOperation(
  storage: PostgresPiSessionStorage,
  operation: PiSessionMutationOperation,
): Promise<Entry | LaneRecord | undefined> {
  switch (operation.kind) {
    case "create_lane":
      await storage.createLane(operation.lane, operation.at);
      return undefined;
    case "move_lane":
      await storage.moveLane(operation.lane, operation.to);
      return undefined;
    case "append_entry":
      return storage.appendEntry(operation.entry, operation.lane);
    case "append_record":
      return storage.appendRecord(operation.record);
    case "set_name":
      await storage.setName(operation.name);
      return undefined;
    case "set_label":
      await storage.setLabel(operation.id, operation.label);
      return undefined;
    case "projection_barrier":
      throw new Error("Projection barriers do not mutate Pi SessionStorage");
  }
}
