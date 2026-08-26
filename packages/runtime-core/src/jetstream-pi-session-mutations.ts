import type { Database } from "@pi-cloud/database";
import { parseExecutionGrant } from "@pi-cloud/protocol";
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
import type { Kysely, Transaction } from "kysely";
import {
  PI_SESSION_MUTATION_STREAM_NAME,
  PI_SESSION_MUTATION_SUBJECT_PREFIX,
  piSessionMutationSubject,
  type PiCloudJetStream,
} from "./jetstream-runtime.ts";

export const PI_SESSION_MUTATION_PROJECTOR_CONSUMER = "PI_CLOUD_SESSION_PROJECTOR";
export const PI_SESSION_MUTATION_INGEST_PATH = "/internal/v1/pi-session-mutations";
const MAXIMUM_AUTHORITY_BATCH = 256;
const AUTHORITY_BATCH_DELAY_MS = 2;
const MAXIMUM_QUEUED_MUTATIONS = 20_000;

export type JetStreamPiSessionMutationScope = Readonly<{
  tenantId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  executionGrant: string;
}>;

export type PiSessionMutationRequest = Readonly<{
  schemaVersion: 1;
  mutationId: string;
  scope: JetStreamPiSessionMutationScope;
  operation: PiSessionMutationOperation;
  occurredAt: string;
}>;

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

export function parsePiSessionMutationRequest(
  value: Uint8Array | Buffer | string,
): PiSessionMutationRequest {
  const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  const candidate = object(JSON.parse(text) as unknown, "Pi Session mutation envelope");
  const scope = object(candidate.scope, "Pi Session mutation scope");
  const executionGrant = string(scope.executionGrant, "ExecutionGrant", 256);
  parseExecutionGrant(executionGrant);
  const occurredAt = string(candidate.occurredAt, "Pi Session mutation timestamp", 64);
  if (candidate.schemaVersion !== 1 || Number.isNaN(new Date(occurredAt).valueOf())) {
    throw new TypeError("Pi Session mutation envelope is invalid");
  }
  return {
    schemaVersion: 1,
    mutationId: uuid(candidate.mutationId, "Pi Session mutation ID"),
    scope: {
      tenantId: uuid(scope.tenantId, "tenant ID"),
      sessionId: string(scope.sessionId, "Session ID", 512),
      turnId: uuid(scope.turnId, "Turn ID"),
      runId: uuid(scope.runId, "Run ID"),
      executionGrant,
    },
    operation: parseOperation(candidate.operation),
    occurredAt,
  };
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

export class PiSessionMutationIngestError extends Error {
  readonly code: "stale_execution_grant" | "ingest_unavailable" | "invalid_mutation";
  readonly retryable: boolean;

  constructor(code: PiSessionMutationIngestError["code"], message: string, retryable = false) {
    super(message);
    this.name = "PiSessionMutationIngestError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type PiSessionMutationAuthorityResult = Readonly<{
  accepted: readonly AcceptedPiSessionMutationEnvelope[];
  rejected: readonly PiSessionMutationRequest[];
}>;

type PiSessionMutationDurableCommit = (
  envelopes: readonly AcceptedPiSessionMutationEnvelope[],
) => Promise<void>;

type ExecutionGrantRow = Readonly<{
  grantId: string;
  executionId: string;
  generation: string;
  tenantId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  validUntil: Date;
}>;

function acceptedMutation(
  request: PiSessionMutationRequest,
  row: ExecutionGrantRow,
): AcceptedPiSessionMutationEnvelope {
  return {
    schemaVersion: 2,
    mutationId: request.mutationId,
    scope: {
      tenantId: row.tenantId,
      sessionId: row.sessionId,
      turnId: row.turnId,
      runId: row.runId,
      executionId: row.executionId,
    },
    operation: request.operation,
    occurredAt: request.occurredAt,
  };
}

export class PostgresPiSessionMutationAuthority {
  readonly #database: Kysely<Database>;
  readonly #clock: () => Date;

  constructor(options: { database: Kysely<Database>; clock?: () => Date }) {
    this.#database = options.database;
    this.#clock = options.clock ?? (() => new Date());
  }

  async commitAcceptedMany(
    requests: readonly PiSessionMutationRequest[],
    durableCommit: PiSessionMutationDurableCommit,
  ): Promise<PiSessionMutationAuthorityResult> {
    if (requests.length < 1 || requests.length > MAXIMUM_AUTHORITY_BATCH) {
      throw new TypeError("Pi Session mutation authority batch is invalid");
    }
    return this.#database.transaction().execute(async (transaction) => {
      const result = await this.#validate(transaction, requests);
      if (result.accepted.length > 0) await durableCommit(result.accepted);
      return result;
    });
  }

  async #validate(
    transaction: Transaction<Database>,
    requests: readonly PiSessionMutationRequest[],
  ): Promise<PiSessionMutationAuthorityResult> {
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
      throw new TypeError("Pi Session mutation authority clock returned an invalid Date");
    }
    const grantIds = [
      ...new Set(
        requests.map((request) => parseExecutionGrant(request.scope.executionGrant).grantId),
      ),
    ];
    const rows = await transaction
      .selectFrom("execution_grants")
      .select([
        "grant_id as grantId",
        "execution_id as executionId",
        "generation",
        "tenant_id as tenantId",
        "session_id as sessionId",
        "turn_id as turnId",
        "run_id as runId",
        "valid_until as validUntil",
      ])
      .where("grant_id", "in", grantIds)
      .orderBy("grant_id", "asc")
      .forUpdate()
      .execute();
    const byGrant = new Map(rows.map((row) => [row.grantId, row as ExecutionGrantRow]));
    const accepted: AcceptedPiSessionMutationEnvelope[] = [];
    const rejected: PiSessionMutationRequest[] = [];
    for (const request of requests) {
      const identity = parseExecutionGrant(request.scope.executionGrant);
      const row = byGrant.get(identity.grantId);
      if (
        row === undefined ||
        row.executionId !== identity.executionId ||
        Number(row.generation) !== identity.generation ||
        row.tenantId !== request.scope.tenantId ||
        row.sessionId !== request.scope.sessionId ||
        row.turnId !== request.scope.turnId ||
        row.runId !== request.scope.runId ||
        new Date(row.validUntil).valueOf() <= now.valueOf()
      ) {
        rejected.push(request);
      } else {
        accepted.push(acceptedMutation(request, row));
      }
    }
    return { accepted, rejected };
  }
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

  async appendGroup(envelopes: readonly AcceptedPiSessionMutationEnvelope[]): Promise<void> {
    const bySession = new Map<string, AcceptedPiSessionMutationEnvelope[]>();
    for (const envelope of envelopes) {
      const group = bySession.get(envelope.scope.sessionId) ?? [];
      group.push(envelope);
      bySession.set(envelope.scope.sessionId, group);
    }
    await Promise.all(
      [...bySession.values()].map(async (group) => {
        for (const envelope of group) {
          await this.append(envelope);
        }
      }),
    );
  }

  async checkHealth(): Promise<void> {
    await this.#runtime.manager.streams.info(PI_SESSION_MUTATION_STREAM_NAME);
  }
}

type PendingMutation = Readonly<{
  request: PiSessionMutationRequest;
  resolve: (value: Readonly<{ mutationId: string; accepted: true }>) => void;
  reject: (error: unknown) => void;
}>;

export class JetStreamPiSessionMutationIngestor {
  readonly #authority: Pick<PostgresPiSessionMutationAuthority, "commitAcceptedMany">;
  readonly #publisher: Pick<
    JetStreamAcceptedPiSessionMutationPublisher,
    "appendGroup" | "checkHealth"
  >;
  #queue: PendingMutation[] = [];
  #timer: NodeJS.Timeout | undefined;
  #flushing: Promise<void> | undefined;
  #closed = false;

  constructor(options: {
    database?: Kysely<Database>;
    publisher: Pick<JetStreamAcceptedPiSessionMutationPublisher, "appendGroup" | "checkHealth">;
    authority?: Pick<PostgresPiSessionMutationAuthority, "commitAcceptedMany">;
  }) {
    if (options.authority === undefined && options.database === undefined) {
      throw new TypeError("Pi Session Mutation Ingest requires a database or authority port");
    }
    this.#authority =
      options.authority ?? new PostgresPiSessionMutationAuthority({ database: options.database! });
    this.#publisher = options.publisher;
  }

  ingest(value: unknown): Promise<Readonly<{ mutationId: string; accepted: true }>> {
    if (this.#closed) {
      return Promise.reject(
        new PiSessionMutationIngestError("ingest_unavailable", "Mutation Ingest is closed", true),
      );
    }
    let request: PiSessionMutationRequest;
    try {
      request = parsePiSessionMutationRequest(JSON.stringify(value));
    } catch (error: unknown) {
      return Promise.reject(
        new PiSessionMutationIngestError("invalid_mutation", "Mutation request is invalid", false),
      );
    }
    if (this.#queue.length >= MAXIMUM_QUEUED_MUTATIONS) {
      return Promise.reject(
        new PiSessionMutationIngestError(
          "ingest_unavailable",
          "Mutation Ingest queue is full",
          true,
        ),
      );
    }
    const result = new Promise<Readonly<{ mutationId: string; accepted: true }>>(
      (resolve, reject) => this.#queue.push({ request, resolve, reject }),
    );
    if (this.#queue.length >= MAXIMUM_AUTHORITY_BATCH) this.#schedule(0);
    else this.#schedule(AUTHORITY_BATCH_DELAY_MS);
    return result;
  }

  async checkHealth(): Promise<void> {
    if (this.#closed) throw new Error("Pi Session Mutation Ingest is unhealthy");
    await this.#publisher.checkHealth();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#flushing !== undefined) await this.#flushing;
    else await this.#drain();
  }

  #schedule(delayMs: number): void {
    if (this.#flushing !== undefined) return;
    if (this.#timer !== undefined) {
      if (delayMs !== 0) return;
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flushing = this.#drain().finally(() => {
        this.#flushing = undefined;
        if (this.#queue.length > 0 && !this.#closed) this.#schedule(0);
      });
    }, delayMs);
    this.#timer.unref();
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, MAXIMUM_AUTHORITY_BATCH);
      try {
        const result = await this.#authority.commitAcceptedMany(
          batch.map((entry) => entry.request),
          (accepted) => this.#publisher.appendGroup(accepted),
        );
        const accepted = new Set(result.accepted.map((entry) => entry.mutationId));
        for (const entry of batch) {
          if (accepted.has(entry.request.mutationId)) {
            entry.resolve({ mutationId: entry.request.mutationId, accepted: true });
          } else {
            entry.reject(
              new PiSessionMutationIngestError(
                "stale_execution_grant",
                "Pi Session mutation was rejected by current ExecutionGrant authority",
              ),
            );
          }
        }
      } catch (error: unknown) {
        for (const entry of batch) entry.reject(error);
      }
    }
  }
}

export class HttpPiSessionMutationProducer {
  readonly #database: Kysely<Database>;
  readonly #url: URL;
  readonly #authorization: string;
  readonly #allowInsecureHttp: boolean;
  #closed = false;

  constructor(options: {
    database: Kysely<Database>;
    baseUrl: string;
    serviceToken: string;
    allowInsecureHttp: boolean;
  }) {
    this.#database = options.database;
    this.#url = new URL(PI_SESSION_MUTATION_INGEST_PATH, options.baseUrl);
    this.#authorization = `Bearer ${options.serviceToken}`;
    this.#allowInsecureHttp = options.allowInsecureHttp;
    if (this.#url.protocol === "http:" && !this.#allowInsecureHttp) {
      throw new TypeError("Plain HTTP Pi Session Mutation Ingest requires explicit opt-in");
    }
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
    const response = await fetch(new URL(`${PI_SESSION_MUTATION_INGEST_PATH}/health`, this.#url), {
      headers: { authorization: this.#authorization },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("Pi Session Mutation Ingest is unavailable");
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
    let ambiguous = false;
    let stopSubmitting = false;
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
      if (!accepted && !stopSubmitting && Date.now() >= nextSubmitAt) {
        const outcome = await this.#submit(request).catch(() => "ambiguous" as const);
        if (outcome === "accepted") {
          accepted = true;
        } else if (outcome === "stale") {
          if (!ambiguous) {
            throw new SessionError(
              "storage",
              "Pi Session mutation was rejected by a stale ExecutionGrant",
            );
          }
          // A prior response may have been lost after PubAck. The stable
          // mutation ID can still appear in the projector result even though
          // the Grant has since expired, so stop resubmitting and wait.
          stopSubmitting = true;
        } else {
          ambiguous = true;
          nextSubmitAt = Date.now() + retryDelayMs;
          retryDelayMs = Math.min(1_000, retryDelayMs * 2);
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  async #submit(request: PiSessionMutationRequest): Promise<"accepted" | "stale" | "ambiguous"> {
    const response = await fetch(this.#url, {
      method: "POST",
      headers: { authorization: this.#authorization, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 409) return "stale";
    if (!response.ok) return "ambiguous";
    const value = (await response.json()) as Record<string, unknown>;
    if (value.accepted !== true || value.mutationId !== request.mutationId) {
      throw new Error("Pi Session Mutation Ingest response is invalid");
    }
    return "accepted";
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
