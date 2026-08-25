import type { Database } from "@pi-cloud/database";
import { parseSupervisorToControlMessage, type EventPublishMessage } from "@pi-cloud/protocol";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

export type AcceptedAgentEventEnvelope = Readonly<{
  schemaVersion: 1;
  tenantId: string;
  publications: readonly EventPublishMessage[];
}>;

export type AgentEventAuthorityResult = Readonly<{
  accepted: readonly AcceptedAgentEventEnvelope[];
  duplicates: readonly EventPublishMessage[];
  rejected: readonly EventPublishMessage[];
}>;

export type AgentEventDurableCommit = (
  envelopes: readonly AcceptedAgentEventEnvelope[],
) => Promise<void>;

function publication(value: unknown): EventPublishMessage {
  const parsed = parseSupervisorToControlMessage(value);
  if (parsed.type !== "event.publish") {
    throw new TypeError("Agent event envelope contains a non-publication");
  }
  return parsed;
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
    envelope.schemaVersion !== 1 ||
    typeof envelope.tenantId !== "string" ||
    envelope.tenantId.length < 1 ||
    envelope.tenantId.length > 256 ||
    !Array.isArray(envelope.publications) ||
    envelope.publications.length < 1 ||
    envelope.publications.length > 128
  ) {
    throw new TypeError("Accepted Agent event envelope is invalid");
  }
  const publications = envelope.publications.map(publication);
  const sessionId = publications[0]!.payload.event.sessionId;
  if (publications.some((message) => message.payload.event.sessionId !== sessionId)) {
    throw new TypeError("Accepted Agent event envelope mixes Sessions");
  }
  return { schemaVersion: 1, tenantId: envelope.tenantId, publications };
}

type AuthorityRow = Readonly<{
  tenantId: string;
  runId: string;
  currentAttemptId: string | null;
  runState: string;
  attemptState: string;
  claimExpiresAt: Date;
  attemptLeaseId: string;
  attemptFence: string;
  lastEventSequence: string;
  commandState: string;
  commandId: string;
  sessionId: string;
  sessionState: string;
  sessionFence: string;
  turnId: string;
  turnState: string;
  leaseId: string;
  leaseFence: string;
  leaseValidUntil: Date;
}>;

function identityMatches(row: AuthorityRow, message: EventPublishMessage): boolean {
  const identity = message.payload;
  const event = identity.event;
  return (
    row.runId === identity.runId &&
    row.currentAttemptId === identity.attemptId &&
    row.attemptLeaseId === identity.leaseId &&
    row.leaseId === identity.leaseId &&
    Number(row.attemptFence) === identity.fencingToken &&
    Number(row.sessionFence) === identity.fencingToken &&
    Number(row.leaseFence) === identity.fencingToken &&
    row.commandId === identity.commandId &&
    row.sessionId === event.sessionId &&
    row.turnId === event.turnId
  );
}

const ACTIVE_RUN_STATES = new Set([
  "provisioning",
  "restoring",
  "running",
  "checkpointing",
  "cancel_requested",
]);
const ACTIVE_ATTEMPT_STATES = ACTIVE_RUN_STATES;
const ACTIVE_SESSION_STATES = new Set(["running", "waiting_approval", "cancelling"]);
const ACTIVE_TURN_STATES = ACTIVE_SESSION_STATES;

function rowIsCurrent(row: AuthorityRow, now: Date): boolean {
  return (
    ACTIVE_RUN_STATES.has(row.runState) &&
    ACTIVE_ATTEMPT_STATES.has(row.attemptState) &&
    row.commandState === "acknowledged" &&
    ACTIVE_SESSION_STATES.has(row.sessionState) &&
    ACTIVE_TURN_STATES.has(row.turnState) &&
    new Date(row.claimExpiresAt).valueOf() > now.valueOf() &&
    new Date(row.leaseValidUntil).valueOf() > now.valueOf()
  );
}

export class PostgresAgentEventAuthority {
  readonly #database: Kysely<Database>;
  readonly #clock: () => Date;

  constructor(options: { database: Kysely<Database>; clock?: () => Date }) {
    this.#database = options.database;
    this.#clock = options.clock ?? (() => new Date());
  }

  async validateMany(messages: readonly EventPublishMessage[]): Promise<AgentEventAuthorityResult> {
    return this.#validateMany(this.#database, messages, false);
  }

  async commitAcceptedMany(
    messages: readonly EventPublishMessage[],
    durableCommit: AgentEventDurableCommit,
  ): Promise<AgentEventAuthorityResult> {
    return this.#database.transaction().execute(async (transaction) => {
      const result = await this.#validateMany(transaction, messages, true);
      if (result.accepted.length === 0) return result;
      await durableCommit(result.accepted);
      await this.#confirmAcceptedMany(transaction, result.accepted);
      return result;
    });
  }

  async #validateMany(
    database: Kysely<Database> | Transaction<Database>,
    messages: readonly EventPublishMessage[],
    lockAuthority: boolean,
  ): Promise<AgentEventAuthorityResult> {
    if (messages.length < 1 || messages.length > 256) {
      throw new TypeError("Agent event authority batch is invalid");
    }
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
      throw new TypeError("Agent event authority clock returned an invalid Date");
    }
    const runIds = [...new Set(messages.map((message) => message.payload.runId))];
    let query = database
      .selectFrom("runs as run")
      .innerJoin("run_attempts as attempt", (join) =>
        join
          .onRef("attempt.tenant_id", "=", "run.tenant_id")
          .onRef("attempt.run_id", "=", "run.id")
          .onRef("attempt.id", "=", "run.current_attempt_id"),
      )
      .innerJoin("commands as command", (join) =>
        join
          .onRef("command.tenant_id", "=", "run.tenant_id")
          .onRef("command.id", "=", "run.command_id"),
      )
      .innerJoin("sessions as session_row", (join) =>
        join
          .onRef("session_row.tenant_id", "=", "run.tenant_id")
          .onRef("session_row.id", "=", "run.session_id"),
      )
      .innerJoin("turns as turn", (join) =>
        join.onRef("turn.tenant_id", "=", "run.tenant_id").onRef("turn.id", "=", "run.turn_id"),
      )
      .innerJoin("session_leases as lease", (join) =>
        join
          .onRef("lease.session_id", "=", "run.session_id")
          .onRef("lease.lease_id", "=", "attempt.lease_id"),
      )
      .select([
        "run.tenant_id as tenantId",
        "run.id as runId",
        "run.current_attempt_id as currentAttemptId",
        "run.state as runState",
        "attempt.state as attemptState",
        "attempt.claim_expires_at as claimExpiresAt",
        "attempt.lease_id as attemptLeaseId",
        "attempt.fencing_token as attemptFence",
        "attempt.last_event_seq as lastEventSequence",
        "command.state as commandState",
        "command.id as commandId",
        "session_row.id as sessionId",
        "session_row.state as sessionState",
        "session_row.last_fencing_token as sessionFence",
        "turn.id as turnId",
        "turn.state as turnState",
        "lease.lease_id as leaseId",
        "lease.fencing_token as leaseFence",
        "lease.valid_until as leaseValidUntil",
      ])
      .where("run.id", "in", runIds)
      .orderBy("run.id", "asc");
    if (lockAuthority) {
      query = query.forUpdate(["run", "attempt", "command", "session_row", "turn", "lease"]);
    }
    const rows = await query.execute();
    const rowByRun = new Map(rows.map((row) => [row.runId, row as AuthorityRow]));
    const accepted: AcceptedAgentEventEnvelope[] = [];
    const duplicates: EventPublishMessage[] = [];
    const rejected: EventPublishMessage[] = [];
    const expectedByRun = new Map<string, number>();
    const seenEventIds = new Set<string>();
    for (const message of messages) {
      const row = rowByRun.get(message.payload.runId);
      if (row === undefined || !identityMatches(row, message)) {
        rejected.push(message);
        continue;
      }
      const event = message.payload.event;
      const persistedThrough = Number(row.lastEventSequence);
      if (event.seq <= persistedThrough || seenEventIds.has(event.eventId)) {
        duplicates.push(message);
        continue;
      }
      if (!rowIsCurrent(row, now)) {
        rejected.push(message);
        continue;
      }
      const expected = expectedByRun.get(row.runId) ?? persistedThrough;
      if (event.seq !== expected + 1) {
        rejected.push(message);
        continue;
      }
      expectedByRun.set(row.runId, event.seq);
      seenEventIds.add(event.eventId);
      accepted.push({ schemaVersion: 1, tenantId: row.tenantId, publications: [message] });
    }
    return { accepted, duplicates, rejected };
  }

  async confirmAcceptedMany(envelopes: readonly AcceptedAgentEventEnvelope[]): Promise<void> {
    await this.#confirmAcceptedMany(this.#database, envelopes);
  }

  async #confirmAcceptedMany(
    database: Kysely<Database> | Transaction<Database>,
    envelopes: readonly AcceptedAgentEventEnvelope[],
  ): Promise<void> {
    if (envelopes.length === 0) return;
    const byAttempt = new Map<
      string,
      {
        tenantId: string;
        runId: string;
        attemptId: string;
        leaseId: string;
        fence: number;
        sequence: number;
      }
    >();
    for (const envelope of envelopes) {
      const message = envelope.publications[0]!;
      const identity = message.payload;
      const key = `${envelope.tenantId}\0${identity.attemptId}`;
      const current = byAttempt.get(key);
      if (current === undefined || identity.event.seq > current.sequence) {
        byAttempt.set(key, {
          tenantId: envelope.tenantId,
          runId: identity.runId,
          attemptId: identity.attemptId,
          leaseId: identity.leaseId,
          fence: identity.fencingToken,
          sequence: identity.event.seq,
        });
      }
    }
    const values = [...byAttempt.values()];
    const result = await sql<{ id: string }>`
      with accepted as (
        select * from jsonb_to_recordset(${JSON.stringify(values)}::jsonb) as item(
          "tenantId" uuid,
          "runId" uuid,
          "attemptId" uuid,
          "leaseId" uuid,
          fence bigint,
          sequence bigint
        )
      )
      update run_attempts as attempt
      set last_event_seq = greatest(attempt.last_event_seq, accepted.sequence),
          updated_at = ${this.#clock()}
      from accepted
      where attempt.tenant_id = accepted."tenantId"
        and attempt.run_id = accepted."runId"
        and attempt.id = accepted."attemptId"
        and attempt.lease_id = accepted."leaseId"
        and attempt.fencing_token = accepted.fence
        and attempt.state in ('provisioning', 'restoring', 'running', 'checkpointing', 'cancel_requested')
      returning attempt.id
    `.execute(database);
    if (result.rows.length !== values.length) {
      throw new Error("Accepted Agent event batch lost RunAttempt authority");
    }
  }
}
