import type { Database } from "@pi-cloud/database";
import {
  parseExecutionGrant,
  parsePiCloudEvent,
  type EventPublishMessage,
  type PiCloudEvent,
} from "@pi-cloud/protocol";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

export type AcceptedAgentEventEnvelope = Readonly<{
  schemaVersion: 2;
  tenantId: string;
  events: readonly PiCloudEvent[];
  /** Transient commit identity. Publishers must not serialize this capability metadata. */
  authority?: Readonly<{
    grantId: string;
    executionId: string;
    generation: number;
  }>;
}>;

export type AgentEventAuthorityResult = Readonly<{
  accepted: readonly AcceptedAgentEventEnvelope[];
  duplicates: readonly EventPublishMessage[];
  rejected: readonly EventPublishMessage[];
}>;

export type AgentEventDurableCommit = (
  envelopes: readonly AcceptedAgentEventEnvelope[],
) => Promise<void>;

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

type ExecutionGrantAuthorityRow = Readonly<{
  grantId: string;
  executionId: string;
  generation: string;
  tenantId: string;
  projectId: string;
  workspaceId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  commandId: string;
  validUntil: Date;
  lastEventSeq: string;
}>;

function identityMatches(row: ExecutionGrantAuthorityRow, message: EventPublishMessage): boolean {
  const identity = parseExecutionGrant(message.payload.executionGrant);
  const event = message.payload.event;
  return (
    row.grantId === identity.grantId &&
    row.executionId === identity.executionId &&
    Number(row.generation) === identity.generation &&
    row.sessionId === event.sessionId &&
    row.turnId === event.turnId
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
    const grantIds = [
      ...new Set(
        messages.map((message) => parseExecutionGrant(message.payload.executionGrant).grantId),
      ),
    ];
    let query = database
      .selectFrom("execution_grants as grant")
      .select([
        "grant.grant_id as grantId",
        "grant.execution_id as executionId",
        "grant.generation as generation",
        "grant.tenant_id as tenantId",
        "grant.project_id as projectId",
        "grant.workspace_id as workspaceId",
        "grant.run_id as runId",
        "grant.session_id as sessionId",
        "grant.turn_id as turnId",
        "grant.command_id as commandId",
        "grant.valid_until as validUntil",
        "grant.last_event_seq as lastEventSeq",
      ])
      .where("grant.grant_id", "in", grantIds)
      .orderBy("grant.grant_id", "asc");
    if (lockAuthority) {
      query = query.forUpdate("grant");
    }
    const rows = await query.execute();
    const rowByGrant = new Map(rows.map((row) => [row.grantId, row as ExecutionGrantAuthorityRow]));
    const accepted: AcceptedAgentEventEnvelope[] = [];
    const duplicates: EventPublishMessage[] = [];
    const rejected: EventPublishMessage[] = [];
    const expectedByGrant = new Map<string, number>();
    const seenEventIds = new Set<string>();
    for (const message of messages) {
      const grantIdentity = parseExecutionGrant(message.payload.executionGrant);
      const row = rowByGrant.get(grantIdentity.grantId);
      if (row === undefined || !identityMatches(row, message)) {
        rejected.push(message);
        continue;
      }
      const event = message.payload.event;
      const persistedThrough = Number(row.lastEventSeq);
      if (event.seq <= persistedThrough || seenEventIds.has(event.eventId)) {
        duplicates.push(message);
        continue;
      }
      if (new Date(row.validUntil).valueOf() <= now.valueOf()) {
        rejected.push(message);
        continue;
      }
      const expected = expectedByGrant.get(row.grantId) ?? persistedThrough;
      if (event.seq !== expected + 1) {
        rejected.push(message);
        continue;
      }
      expectedByGrant.set(row.grantId, event.seq);
      seenEventIds.add(event.eventId);
      accepted.push({
        schemaVersion: 2,
        tenantId: row.tenantId,
        events: [event],
        authority: {
          grantId: grantIdentity.grantId,
          executionId: grantIdentity.executionId,
          generation: grantIdentity.generation,
        },
      });
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
    const byGrant = new Map<
      string,
      {
        grantId: string;
        executionId: string;
        generation: number;
        sequence: number;
      }
    >();
    for (const envelope of envelopes) {
      const event = envelope.events[0]!;
      const identity = envelope.authority;
      if (identity === undefined) throw new Error("Accepted Agent event authority is missing");
      const current = byGrant.get(identity.grantId);
      if (current === undefined || event.seq > current.sequence) {
        byGrant.set(identity.grantId, {
          grantId: identity.grantId,
          executionId: identity.executionId,
          generation: identity.generation,
          sequence: event.seq,
        });
      }
    }
    const values = [...byGrant.values()];
    const result = await sql<{ id: string }>`
      with accepted as (
        select * from jsonb_to_recordset(${JSON.stringify(values)}::jsonb) as item(
          "grantId" uuid,
          "executionId" uuid,
          generation bigint,
          sequence bigint
        )
      )
      update execution_grants as authority
      set last_event_seq = greatest(authority.last_event_seq, accepted.sequence)
      from accepted
      where authority.grant_id = accepted."grantId"
        and authority.execution_id = accepted."executionId"
        and authority.generation = accepted.generation
        and authority.valid_until > ${this.#clock()}
      returning authority.grant_id as id
    `.execute(database);
    if (result.rows.length !== values.length) {
      throw new Error("Accepted Agent event batch lost ExecutionGrant authority");
    }
  }
}
