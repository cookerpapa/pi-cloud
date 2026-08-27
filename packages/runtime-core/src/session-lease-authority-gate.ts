import type { Database } from "@pi-cloud/database";
import { parseExecutionLease } from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { AcceptedFact, CandidateFact } from "./accepted-fact.ts";

const DEFAULT_FACT_CHANNEL_LEASE_MS = 9_000;

export type ExecutionLeaseAuthorityRequest = Readonly<{
  executionLease: string;
  sessionId: string;
  turnId: string;
}>;

export type ExecutionLeaseAuthorityScope = Readonly<{
  connectionId: string;
  instanceId: string;
  executionLease: string;
  leaseId: string;
  attemptId: string;
  fencingToken: number;
  tenantId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  leaseDurationMs: number;
}>;

export class ExecutionLeaseAuthorityGateError extends Error {
  readonly code: "stale_session_lease" | "fact_channel_conflict" | "authority_invariant";
  readonly retryable: boolean;

  constructor(
    code: ExecutionLeaseAuthorityGateError["code"],
    safeMessage: string,
    retryable: boolean,
  ) {
    super(safeMessage);
    this.name = "ExecutionLeaseAuthorityGateError";
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
    throw new ExecutionLeaseAuthorityGateError(
      "stale_session_lease",
      "ExecutionLease expired before the FactChannel could be renewed",
      false,
    );
  }
  return value;
}

export class PostgresExecutionLeaseAuthorityGate {
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
    request: ExecutionLeaseAuthorityRequest,
    identity: Readonly<{ connectionId: string; instanceId: string }>,
  ): Promise<ExecutionLeaseAuthorityScope> {
    const now = validClockDate(this.#clock);
    const grantIdentity = parseExecutionLease(request.executionLease);
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("session_leases")
        .selectAll()
        .where("lease_id", "=", grantIdentity.leaseId)
        .forUpdate()
        .executeTakeFirst();
      const grantExpiry = row === undefined ? now : new Date(row.valid_until);
      if (
        row === undefined ||
        row.attempt_id !== grantIdentity.attemptId ||
        Number(row.fencing_token) !== grantIdentity.fencingToken ||
        row.session_id !== request.sessionId ||
        row.turn_id !== request.turnId ||
        grantExpiry.valueOf() <= now.valueOf()
      ) {
        throw new ExecutionLeaseAuthorityGateError(
          "stale_session_lease",
          "FactChannel rejected a stale ExecutionLease",
          false,
        );
      }
      if (
        row.fact_channel_connection_id !== null &&
        row.fact_channel_valid_until !== null &&
        new Date(row.fact_channel_valid_until).valueOf() > now.valueOf()
      ) {
        throw new ExecutionLeaseAuthorityGateError(
          "fact_channel_conflict",
          "ExecutionLease already has an active FactChannel",
          true,
        );
      }
      const validUntil = writerLeaseExpiry(now, grantExpiry, this.#leaseDurationMs);
      const updated = await transaction
        .updateTable("session_leases")
        .set({
          fact_channel_connection_id: identity.connectionId,
          fact_channel_instance_id: identity.instanceId,
          fact_channel_valid_until: validUntil,
        })
        .where("lease_id", "=", grantIdentity.leaseId)
        .where("attempt_id", "=", grantIdentity.attemptId)
        .where("fencing_token", "=", String(grantIdentity.fencingToken))
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) {
        throw new ExecutionLeaseAuthorityGateError(
          "authority_invariant",
          "FactChannel ownership changed while opening",
          false,
        );
      }
      return {
        connectionId: identity.connectionId,
        instanceId: identity.instanceId,
        executionLease: request.executionLease,
        leaseId: grantIdentity.leaseId,
        attemptId: grantIdentity.attemptId,
        fencingToken: grantIdentity.fencingToken,
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        runId: row.run_id,
        turnId: row.turn_id,
        leaseDurationMs: validUntil.valueOf() - now.valueOf(),
      };
    });
  }

  accept(scope: ExecutionLeaseAuthorityScope, candidate: CandidateFact): AcceptedFact {
    if (candidate.kind === "agent_event") {
      const publication = candidate.publication;
      if (
        publication.payload.executionLease !== scope.executionLease ||
        publication.payload.event.sessionId !== scope.sessionId ||
        publication.payload.event.turnId !== scope.turnId
      ) {
        throw new ExecutionLeaseAuthorityGateError(
          "stale_session_lease",
          "Agent event candidate does not belong to its ExecutionLease",
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
          attemptId: scope.attemptId,
          fencingToken: scope.fencingToken,
        },
        event: publication.payload.event,
        occurredAt: publication.payload.event.occurredAt,
      };
    }
    const mutation = candidate.mutation;
    if (
      mutation.scope.executionLease !== scope.executionLease ||
      mutation.scope.tenantId !== scope.tenantId ||
      mutation.scope.sessionId !== scope.sessionId ||
      mutation.scope.runId !== scope.runId ||
      mutation.scope.turnId !== scope.turnId
    ) {
      throw new ExecutionLeaseAuthorityGateError(
        "stale_session_lease",
        "Pi Session mutation candidate does not belong to its ExecutionLease",
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
        attemptId: scope.attemptId,
        fencingToken: scope.fencingToken,
      },
      operation: mutation.operation,
      occurredAt: mutation.occurredAt,
    };
  }

  async renewMany(
    writers: readonly ExecutionLeaseAuthorityScope[],
  ): Promise<ReadonlyMap<string, number>> {
    if (writers.length < 1 || writers.length > 1_000) {
      throw new TypeError("FactChannel renewal set is invalid");
    }
    const now = validClockDate(this.#clock);
    const requestedUntil = new Date(now.valueOf() + this.#leaseDurationMs);
    const requested = writers.map((scope) => ({
      leaseId: scope.leaseId,
      attemptId: scope.attemptId,
      fencingToken: scope.fencingToken,
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
          "leaseId" uuid,
          "attemptId" uuid,
          "fencingToken" bigint,
          "sessionId" uuid,
          "turnId" uuid,
          "connectionId" uuid,
          "instanceId" uuid
        )
      )
      update session_leases as authority
         set fact_channel_valid_until = least(authority.valid_until, ${requestedUntil})
        from requested
       where authority.lease_id = requested."leaseId"
         and authority.attempt_id = requested."attemptId"
         and authority.fencing_token = requested."fencingToken"
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

  async close(scope: ExecutionLeaseAuthorityScope): Promise<void> {
    const updated = await this.#database
      .updateTable("session_leases")
      .set({
        fact_channel_connection_id: null,
        fact_channel_instance_id: null,
        fact_channel_valid_until: null,
      })
      .where("lease_id", "=", scope.leaseId)
      .where("attempt_id", "=", scope.attemptId)
      .where("fencing_token", "=", String(scope.fencingToken))
      .where("fact_channel_connection_id", "=", scope.connectionId)
      .where("fact_channel_instance_id", "=", scope.instanceId)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      const current = await this.#database
        .selectFrom("session_leases")
        .select("fact_channel_connection_id")
        .where("lease_id", "=", scope.leaseId)
        .where("attempt_id", "=", scope.attemptId)
        .where("fencing_token", "=", String(scope.fencingToken))
        .executeTakeFirst();
      if (current !== undefined && current.fact_channel_connection_id === null) {
        return;
      }
      throw new ExecutionLeaseAuthorityGateError(
        "stale_session_lease",
        "FactChannel could not close stale ownership",
        false,
      );
    }
  }
}
