import type { Database } from "@pi-cloud/database";
import { parseExecutionGrant } from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { AcceptedFact, CandidateFact } from "./accepted-fact.ts";

const DEFAULT_FACT_CHANNEL_LEASE_MS = 9_000;

export type ExecutionGrantAuthorityRequest = Readonly<{
  executionGrant: string;
  sessionId: string;
  turnId: string;
}>;

export type ExecutionGrantAuthorityScope = Readonly<{
  connectionId: string;
  instanceId: string;
  executionGrant: string;
  grantId: string;
  executionId: string;
  generation: number;
  tenantId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  leaseDurationMs: number;
}>;

export class ExecutionGrantAuthorityGateError extends Error {
  readonly code: "stale_execution_grant" | "fact_channel_conflict" | "authority_invariant";
  readonly retryable: boolean;

  constructor(
    code: ExecutionGrantAuthorityGateError["code"],
    safeMessage: string,
    retryable: boolean,
  ) {
    super(safeMessage);
    this.name = "ExecutionGrantAuthorityGateError";
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
    throw new TypeError("FactChannel clock returned an invalid Date");
  }
  return value;
}

function writerLeaseExpiry(now: Date, grantExpiry: Date, durationMs: number): Date {
  const value = new Date(Math.min(now.valueOf() + durationMs, grantExpiry.valueOf()));
  if (value.valueOf() <= now.valueOf()) {
    throw new ExecutionGrantAuthorityGateError(
      "stale_execution_grant",
      "ExecutionGrant expired before the FactChannel could be renewed",
      false,
    );
  }
  return value;
}

export class PostgresExecutionGrantAuthorityGate {
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
      options.leaseDurationMs ?? DEFAULT_FACT_CHANNEL_LEASE_MS,
      "leaseDurationMs",
    );
  }

  async open(
    request: ExecutionGrantAuthorityRequest,
    identity: Readonly<{ connectionId: string; instanceId: string }>,
  ): Promise<ExecutionGrantAuthorityScope> {
    const now = validClockDate(this.#clock);
    const grantIdentity = parseExecutionGrant(request.executionGrant);
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
        row.session_id !== request.sessionId ||
        row.turn_id !== request.turnId ||
        grantExpiry.valueOf() <= now.valueOf()
      ) {
        throw new ExecutionGrantAuthorityGateError(
          "stale_execution_grant",
          "FactChannel rejected a stale ExecutionGrant",
          false,
        );
      }
      if (
        row.fact_channel_connection_id !== null &&
        row.fact_channel_valid_until !== null &&
        new Date(row.fact_channel_valid_until).valueOf() > now.valueOf()
      ) {
        throw new ExecutionGrantAuthorityGateError(
          "fact_channel_conflict",
          "ExecutionGrant already has an active FactChannel",
          true,
        );
      }
      const validUntil = writerLeaseExpiry(now, grantExpiry, this.#leaseDurationMs);
      const updated = await transaction
        .updateTable("execution_grants")
        .set({
          fact_channel_connection_id: identity.connectionId,
          fact_channel_instance_id: identity.instanceId,
          fact_channel_valid_until: validUntil,
        })
        .where("grant_id", "=", grantIdentity.grantId)
        .where("execution_id", "=", grantIdentity.executionId)
        .where("generation", "=", String(grantIdentity.generation))
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) {
        throw new ExecutionGrantAuthorityGateError(
          "authority_invariant",
          "FactChannel ownership changed while opening",
          false,
        );
      }
      return {
        connectionId: identity.connectionId,
        instanceId: identity.instanceId,
        executionGrant: request.executionGrant,
        grantId: grantIdentity.grantId,
        executionId: grantIdentity.executionId,
        generation: grantIdentity.generation,
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        runId: row.run_id,
        turnId: row.turn_id,
        leaseDurationMs: validUntil.valueOf() - now.valueOf(),
      };
    });
  }

  accept(scope: ExecutionGrantAuthorityScope, candidate: CandidateFact): AcceptedFact {
    if (candidate.kind === "agent_event") {
      const publication = candidate.publication;
      if (
        publication.payload.executionGrant !== scope.executionGrant ||
        publication.payload.event.sessionId !== scope.sessionId ||
        publication.payload.event.turnId !== scope.turnId
      ) {
        throw new ExecutionGrantAuthorityGateError(
          "stale_execution_grant",
          "Agent event candidate does not belong to its ExecutionGrant",
          false,
        );
      }
      return {
        kind: "agent_event",
        factId: publication.payload.event.eventId,
        scope: {
          tenantId: scope.tenantId,
          sessionId: scope.sessionId,
          runId: scope.runId,
          turnId: scope.turnId,
          executionId: scope.executionId,
          executionGeneration: scope.generation,
        },
        event: publication.payload.event,
        occurredAt: publication.payload.event.occurredAt,
      };
    }
    const mutation = candidate.mutation;
    if (
      mutation.scope.executionGrant !== scope.executionGrant ||
      mutation.scope.tenantId !== scope.tenantId ||
      mutation.scope.sessionId !== scope.sessionId ||
      mutation.scope.runId !== scope.runId ||
      mutation.scope.turnId !== scope.turnId
    ) {
      throw new ExecutionGrantAuthorityGateError(
        "stale_execution_grant",
        "Pi Session mutation candidate does not belong to its ExecutionGrant",
        false,
      );
    }
    return {
      kind: "pi_session_mutation",
      factId: mutation.mutationId,
      scope: {
        tenantId: scope.tenantId,
        sessionId: scope.sessionId,
        runId: scope.runId,
        turnId: scope.turnId,
        executionId: scope.executionId,
        executionGeneration: scope.generation,
      },
      operation: mutation.operation,
      occurredAt: mutation.occurredAt,
    };
  }

  async renewMany(
    writers: readonly ExecutionGrantAuthorityScope[],
  ): Promise<ReadonlyMap<string, number>> {
    if (writers.length < 1 || writers.length > 1_000) {
      throw new TypeError("FactChannel renewal set is invalid");
    }
    const now = validClockDate(this.#clock);
    const requestedUntil = new Date(now.valueOf() + this.#leaseDurationMs);
    const requested = writers.map((scope) => ({
      grantId: scope.grantId,
      executionId: scope.executionId,
      generation: scope.generation,
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      connectionId: scope.connectionId,
      instanceId: scope.instanceId,
    }));
    if (new Set(requested.map((writer) => writer.connectionId)).size !== requested.length) {
      throw new TypeError("FactChannel renewal set contains duplicate connections");
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
          "instanceId" uuid
        )
      )
      update execution_grants as authority
         set fact_channel_valid_until = least(authority.valid_until, ${requestedUntil})
        from requested
       where authority.grant_id = requested."grantId"
         and authority.execution_id = requested."executionId"
         and authority.generation = requested.generation
         and authority.session_id = requested."sessionId"
         and authority.turn_id = requested."turnId"
         and authority.fact_channel_connection_id = requested."connectionId"
         and authority.fact_channel_instance_id = requested."instanceId"
         and authority.fact_channel_valid_until > ${now}
         and authority.valid_until > ${now}
      returning authority.fact_channel_connection_id as "connectionId",
                authority.fact_channel_valid_until as "validUntil"
    `.execute(this.#database);
    return new Map(
      renewed.rows.map((row) => [
        row.connectionId,
        new Date(row.validUntil).valueOf() - now.valueOf(),
      ]),
    );
  }

  async close(scope: ExecutionGrantAuthorityScope): Promise<void> {
    const updated = await this.#database
      .updateTable("execution_grants")
      .set({
        fact_channel_connection_id: null,
        fact_channel_instance_id: null,
        fact_channel_valid_until: null,
      })
      .where("grant_id", "=", scope.grantId)
      .where("execution_id", "=", scope.executionId)
      .where("generation", "=", String(scope.generation))
      .where("fact_channel_connection_id", "=", scope.connectionId)
      .where("fact_channel_instance_id", "=", scope.instanceId)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      const current = await this.#database
        .selectFrom("execution_grants")
        .select("fact_channel_connection_id")
        .where("grant_id", "=", scope.grantId)
        .where("execution_id", "=", scope.executionId)
        .where("generation", "=", String(scope.generation))
        .executeTakeFirst();
      if (current !== undefined && current.fact_channel_connection_id === null) {
        return;
      }
      throw new ExecutionGrantAuthorityGateError(
        "stale_execution_grant",
        "FactChannel could not close stale ownership",
        false,
      );
    }
  }
}
