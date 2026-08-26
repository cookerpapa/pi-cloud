import type { Database } from "@pi-cloud/database";
import {
  parseExecutionGrant,
  parsePiCloudEvent,
  type EventWriterOpenMessage,
  type PiCloudEvent,
} from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import { sql } from "kysely";

export type AcceptedAgentEventEnvelope = Readonly<{
  schemaVersion: 2;
  tenantId: string;
  events: readonly PiCloudEvent[];
}>;

const DEFAULT_EVENT_WRITER_LEASE_MS = 9_000;

export type AgentEventDurableTail = Readonly<{
  eventId: string;
  seq: number;
}>;

export type AgentEventWriterAuthorityScope = Readonly<{
  connectionId: string;
  instanceId: string;
  executionGrant: string;
  grantId: string;
  executionId: string;
  generation: number;
  tenantId: string;
  sessionId: string;
  turnId: string;
  acknowledgedThroughSeq: number;
  acknowledgedEventId?: string;
  leaseDurationMs: number;
}>;

export class AgentEventWriterAuthorityError extends Error {
  readonly code: "stale_execution_grant" | "event_writer_conflict" | "event_writer_invariant";
  readonly retryable: boolean;

  constructor(
    code: AgentEventWriterAuthorityError["code"],
    safeMessage: string,
    retryable: boolean,
  ) {
    super(safeMessage);
    this.name = "AgentEventWriterAuthorityError";
    this.code = code;
    this.retryable = retryable;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} is invalid`);
  return value;
}

function validClockDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Agent event writer clock returned an invalid Date");
  }
  return value;
}

function boundedSequence(value: string | number | bigint, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AgentEventWriterAuthorityError(
      "event_writer_invariant",
      `${name} is outside the supported sequence range`,
      false,
    );
  }
  return parsed;
}

function writerLeaseExpiry(now: Date, grantExpiry: Date, durationMs: number): Date {
  const value = new Date(Math.min(now.valueOf() + durationMs, grantExpiry.valueOf()));
  if (value.valueOf() <= now.valueOf()) {
    throw new AgentEventWriterAuthorityError(
      "stale_execution_grant",
      "ExecutionGrant expired before the Agent event writer could be renewed",
      false,
    );
  }
  return value;
}

export class PostgresAgentEventWriterAuthority {
  readonly #database: Kysely<Database>;
  readonly #clock: () => Date;
  readonly #leaseDurationMs: number;

  constructor(options: {
    database: Kysely<Database>;
    clock?: () => Date;
    leaseDurationMs?: number;
  }) {
    this.#database = options.database;
    this.#clock = options.clock ?? (() => new Date());
    this.#leaseDurationMs = positiveInteger(
      options.leaseDurationMs ?? DEFAULT_EVENT_WRITER_LEASE_MS,
      "leaseDurationMs",
    );
  }

  async open(
    message: EventWriterOpenMessage,
    identity: Readonly<{ connectionId: string; instanceId: string }>,
    durableTail?: AgentEventDurableTail,
  ): Promise<AgentEventWriterAuthorityScope> {
    const now = validClockDate(this.#clock);
    const grantIdentity = parseExecutionGrant(message.payload.executionGrant);
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("execution_grants")
        .selectAll()
        .where("grant_id", "=", grantIdentity.grantId)
        .forUpdate()
        .executeTakeFirst();
      const grantExpiry = row === undefined ? now : new Date(row.valid_until);
      if (
        row === undefined ||
        row.execution_id !== grantIdentity.executionId ||
        Number(row.generation) !== grantIdentity.generation ||
        row.session_id !== message.payload.sessionId ||
        row.turn_id !== message.payload.turnId ||
        grantExpiry.valueOf() <= now.valueOf()
      ) {
        throw new AgentEventWriterAuthorityError(
          "stale_execution_grant",
          "Agent event writer rejected a stale ExecutionGrant",
          false,
        );
      }
      if (
        row.event_writer_connection_id !== null &&
        row.event_writer_valid_until !== null &&
        new Date(row.event_writer_valid_until).valueOf() > now.valueOf()
      ) {
        throw new AgentEventWriterAuthorityError(
          "event_writer_conflict",
          "ExecutionGrant already has an active Agent event writer",
          true,
        );
      }
      const persistedThrough = boundedSequence(row.last_event_seq, "Grant event watermark");
      const durableThrough = Math.max(persistedThrough, durableTail?.seq ?? 0);
      if (message.payload.nextEventSeq > durableThrough + 1) {
        throw new AgentEventWriterAuthorityError(
          "event_writer_invariant",
          "Agent event writer opened with a sequence gap",
          false,
        );
      }
      const validUntil = writerLeaseExpiry(now, grantExpiry, this.#leaseDurationMs);
      const updated = await transaction
        .updateTable("execution_grants")
        .set({
          event_writer_connection_id: identity.connectionId,
          event_writer_instance_id: identity.instanceId,
          event_writer_valid_until: validUntil,
          last_event_seq: String(durableThrough),
        })
        .where("grant_id", "=", grantIdentity.grantId)
        .where("execution_id", "=", grantIdentity.executionId)
        .where("generation", "=", String(grantIdentity.generation))
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) {
        throw new AgentEventWriterAuthorityError(
          "event_writer_invariant",
          "Agent event writer ownership changed while opening",
          false,
        );
      }
      return {
        connectionId: identity.connectionId,
        instanceId: identity.instanceId,
        executionGrant: message.payload.executionGrant,
        grantId: grantIdentity.grantId,
        executionId: grantIdentity.executionId,
        generation: grantIdentity.generation,
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        acknowledgedThroughSeq: durableThrough,
        ...(durableTail?.seq === durableThrough
          ? { acknowledgedEventId: durableTail.eventId }
          : {}),
        leaseDurationMs: validUntil.valueOf() - now.valueOf(),
      };
    });
  }

  async renewMany(
    writers: readonly Readonly<{
      scope: AgentEventWriterAuthorityScope;
      acknowledgedThroughSeq: number;
    }>[],
  ): Promise<ReadonlyMap<string, number>> {
    if (writers.length < 1 || writers.length > 1_000) {
      throw new TypeError("Agent event writer renewal set is invalid");
    }
    const now = validClockDate(this.#clock);
    const requestedUntil = new Date(now.valueOf() + this.#leaseDurationMs);
    const requested = writers.map(({ scope, acknowledgedThroughSeq }) => ({
      grantId: scope.grantId,
      executionId: scope.executionId,
      generation: scope.generation,
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      connectionId: scope.connectionId,
      instanceId: scope.instanceId,
      sequence: positiveInteger(acknowledgedThroughSeq + 1, "acknowledgedThroughSeq") - 1,
    }));
    if (new Set(requested.map((writer) => writer.connectionId)).size !== requested.length) {
      throw new TypeError("Agent event writer renewal set contains duplicate connections");
    }
    const renewed = await sql<{ connectionId: string; validUntil: Date }>`
      with requested as (
        select * from jsonb_to_recordset(${JSON.stringify(requested)}::jsonb) as item(
          "grantId" uuid,
          "executionId" uuid,
          generation bigint,
          "sessionId" uuid,
          "turnId" uuid,
          "connectionId" uuid,
          "instanceId" uuid,
          sequence bigint
        )
      )
      update execution_grants as authority
         set event_writer_valid_until = least(authority.valid_until, ${requestedUntil}),
             last_event_seq = greatest(authority.last_event_seq, requested.sequence)
        from requested
       where authority.grant_id = requested."grantId"
         and authority.execution_id = requested."executionId"
         and authority.generation = requested.generation
         and authority.session_id = requested."sessionId"
         and authority.turn_id = requested."turnId"
         and authority.event_writer_connection_id = requested."connectionId"
         and authority.event_writer_instance_id = requested."instanceId"
         and authority.event_writer_valid_until > ${now}
         and authority.valid_until > ${now}
      returning authority.event_writer_connection_id as "connectionId",
                authority.event_writer_valid_until as "validUntil"
    `.execute(this.#database);
    return new Map(
      renewed.rows.map((row) => [
        row.connectionId,
        new Date(row.validUntil).valueOf() - now.valueOf(),
      ]),
    );
  }

  async close(
    scope: AgentEventWriterAuthorityScope,
    acknowledgedThroughSeq: number,
  ): Promise<void> {
    const sequence = positiveInteger(acknowledgedThroughSeq + 1, "acknowledgedThroughSeq") - 1;
    const updated = await this.#database
      .updateTable("execution_grants")
      .set({
        event_writer_connection_id: null,
        event_writer_instance_id: null,
        event_writer_valid_until: null,
        last_event_seq: sql<string>`greatest(last_event_seq, ${sequence})`,
      })
      .where("grant_id", "=", scope.grantId)
      .where("execution_id", "=", scope.executionId)
      .where("generation", "=", String(scope.generation))
      .where("event_writer_connection_id", "=", scope.connectionId)
      .where("event_writer_instance_id", "=", scope.instanceId)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      const current = await this.#database
        .selectFrom("execution_grants")
        .select(["event_writer_connection_id", "last_event_seq"])
        .where("grant_id", "=", scope.grantId)
        .where("execution_id", "=", scope.executionId)
        .where("generation", "=", String(scope.generation))
        .executeTakeFirst();
      if (
        current !== undefined &&
        current.event_writer_connection_id === null &&
        boundedSequence(current.last_event_seq, "Grant event watermark") >= sequence
      ) {
        return;
      }
      throw new AgentEventWriterAuthorityError(
        "stale_execution_grant",
        "Agent event writer could not close stale ownership",
        false,
      );
    }
  }
}

export function parseAcceptedAgentEventEnvelope(
  value: Uint8Array | Buffer | string,
): AcceptedAgentEventEnvelope {
  const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  const candidate = JSON.parse(text) as unknown;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new TypeError("Accepted Agent event envelope is invalid");
  }
  const envelope = candidate as Record<string, unknown>;
  if (
    envelope.schemaVersion !== 2 ||
    typeof envelope.tenantId !== "string" ||
    envelope.tenantId.length < 1 ||
    envelope.tenantId.length > 256 ||
    !Array.isArray(envelope.events) ||
    envelope.events.length < 1 ||
    envelope.events.length > 128
  ) {
    throw new TypeError("Accepted Agent event envelope is invalid");
  }
  const events = envelope.events.map(parsePiCloudEvent);
  const sessionId = events[0]!.sessionId;
  if (events.some((event) => event.sessionId !== sessionId)) {
    throw new TypeError("Accepted Agent event envelope mixes Sessions");
  }
  return { schemaVersion: 2, tenantId: envelope.tenantId, events };
}
