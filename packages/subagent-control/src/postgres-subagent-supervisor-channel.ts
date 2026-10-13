import { randomUUID } from "node:crypto";
import type { Database, SubagentSupervisorReason } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";

export class SupervisorChannelError extends Error {}

const MAX_MESSAGE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;

export type CloudSupervisorRequest = Readonly<{
  requestId: string;
  executionId: string;
  reason: SubagentSupervisorReason;
  message: string;
  expectsReply: boolean;
  createdAt: string;
  expiresAt?: string;
  replyMessage?: string;
}>;

function boundedMessage(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SupervisorChannelError(`${label} is required`);
  }
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > MAX_MESSAGE_BYTES) {
    throw new SupervisorChannelError(`${label} is too large`);
  }
  return normalized;
}

function resource(row: {
  id: string;
  executionId: string;
  reason: SubagentSupervisorReason;
  message: string;
  expectsReply: boolean;
  createdAt: Date;
  expiresAt: Date | null;
  replyMessage: string | null;
}): CloudSupervisorRequest {
  return {
    requestId: row.id,
    executionId: row.executionId,
    reason: row.reason,
    message: row.message,
    expectsReply: row.expectsReply,
    createdAt: row.createdAt.toISOString(),
    ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt.toISOString() }),
    ...(row.replyMessage === null ? {} : { replyMessage: row.replyMessage }),
  };
}

export class PostgresSubagentSupervisorChannel {
  readonly #database: Kysely<Database>;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  async contact(input: {
    tenantId: string;
    childSessionId: string;
    rootRunId: string;
    reason: SubagentSupervisorReason;
    message: string;
    interview?: Record<string, unknown>;
    requestId?: string;
  }): Promise<CloudSupervisorRequest> {
    const message = boundedMessage(input.message, "Supervisor message");
    const expectsReply = input.reason !== "progress_update";
    const requestId = input.requestId ?? randomUUID();
    const prior = await this.#database
      .selectFrom("subagent_supervisor_requests")
      .select("id")
      .where("tenant_id", "=", input.tenantId)
      .where("id", "=", requestId)
      .executeTakeFirst();
    if (prior) return this.request(input.tenantId, requestId);
    const created = await this.#database.transaction().execute(async (transaction) => {
      // The link row serializes request deduplication; its state is read from Pi.
      await transaction
        .selectFrom("subagent_conversations")
        .select("id")
        .where("tenant_id", "=", input.tenantId)
        .where("child_session_id", "=", input.childSessionId)
        .where("root_run_id", "=", input.rootRunId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const execution = await transaction
        .selectFrom("subagent_executions")
        .select(["id", "state"])
        .where("tenant_id", "=", input.tenantId)
        .where("child_session_id", "=", input.childSessionId)
        .where("root_run_id", "=", input.rootRunId)
        .executeTakeFirst();
      // Two Projector boots can overlap during handoff. Recheck after taking
      // the execution lock, not only before entering the transaction.
      const existing = await transaction
        .selectFrom("subagent_supervisor_requests")
        .select([
          "id",
          "execution_id as executionId",
          "reason",
          "message",
          "expects_reply as expectsReply",
          "created_at as createdAt",
          "expires_at as expiresAt",
          "reply_message as replyMessage",
        ])
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", requestId)
        .executeTakeFirst();
      if (existing) return resource(existing);
      if (execution === undefined || execution.state !== "running") {
        throw new SupervisorChannelError("Subagent execution is not running");
      }
      const row = await transaction
        .insertInto("subagent_supervisor_requests")
        .values({
          id: requestId,
          tenant_id: input.tenantId,
          execution_id: execution.id,
          reason: input.reason,
          message,
          interview: input.interview ?? null,
          expects_reply: expectsReply,
          reply_message: null,
          expires_at: expectsReply
            ? sql<Date>`clock_timestamp() + ${REQUEST_TIMEOUT_MS} * interval '1 millisecond'`
            : null,
          replied_at: null,
        })
        .returning(["created_at as createdAt", "expires_at as expiresAt"])
        .executeTakeFirstOrThrow();
      return resource({
        id: requestId,
        executionId: execution.id,
        reason: input.reason,
        message,
        expectsReply,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        replyMessage: null,
      });
    });
    return created;
  }

  async request(tenantId: string, requestId: string): Promise<CloudSupervisorRequest> {
    const row = await this.#database
      .selectFrom("subagent_supervisor_requests")
      .select([
        "id",
        "execution_id as executionId",
        "reason",
        "message",
        "expects_reply as expectsReply",
        "created_at as createdAt",
        "expires_at as expiresAt",
        "reply_message as replyMessage",
      ])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", requestId)
      .executeTakeFirstOrThrow();
    return resource(row);
  }

  async latestForExecution(
    tenantId: string,
    executionId: string,
  ): Promise<CloudSupervisorRequest | undefined> {
    const row = await this.#database
      .selectFrom("subagent_supervisor_requests")
      .select([
        "id",
        "execution_id as executionId",
        "reason",
        "message",
        "expects_reply as expectsReply",
        "created_at as createdAt",
        "expires_at as expiresAt",
        "reply_message as replyMessage",
      ])
      .where("tenant_id", "=", tenantId)
      .where("execution_id", "=", executionId)
      .where((expression) =>
        expression.or([
          expression("expects_reply", "=", false),
          expression.and([
            expression("reply_message", "is", null),
            expression("expires_at", ">", sql<Date>`clock_timestamp()`),
          ]),
        ]),
      )
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : resource(row);
  }

  async pendingForParent(
    tenantId: string,
    parentSessionId: string,
  ): Promise<CloudSupervisorRequest[]> {
    const rows = await this.#database
      .selectFrom("subagent_supervisor_requests as request")
      .innerJoin("subagent_executions as execution", (join) =>
        join
          .onRef("execution.tenant_id", "=", "request.tenant_id")
          .onRef("execution.id", "=", "request.execution_id"),
      )
      .select([
        "request.id",
        "request.execution_id as executionId",
        "request.reason",
        "request.message",
        "request.expects_reply as expectsReply",
        "request.created_at as createdAt",
        "request.expires_at as expiresAt",
        "request.reply_message as replyMessage",
      ])
      .where("request.tenant_id", "=", tenantId)
      .where("execution.parent_session_id", "=", parentSessionId)
      .where("request.expects_reply", "=", true)
      .where("request.reply_message", "is", null)
      .where("request.expires_at", ">", sql<Date>`clock_timestamp()`)
      .orderBy("request.created_at", "asc")
      .limit(100)
      .execute();
    return rows.map(resource);
  }

  async requestForParent(
    tenantId: string,
    parentSessionId: string,
    requestId: string,
  ): Promise<CloudSupervisorRequest> {
    const row = await this.#database
      .selectFrom("subagent_supervisor_requests as request")
      .innerJoin("subagent_executions as execution", (join) =>
        join
          .onRef("execution.tenant_id", "=", "request.tenant_id")
          .onRef("execution.id", "=", "request.execution_id"),
      )
      .select([
        "request.id",
        "request.execution_id as executionId",
        "request.reason",
        "request.message",
        "request.expects_reply as expectsReply",
        "request.created_at as createdAt",
        "request.expires_at as expiresAt",
        "request.reply_message as replyMessage",
      ])
      .where("request.tenant_id", "=", tenantId)
      .where("request.id", "=", requestId)
      .where("execution.parent_session_id", "=", parentSessionId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new SupervisorChannelError("Supervisor request was not found for this parent Session");
    }
    return resource(row);
  }

  async reply(input: {
    tenantId: string;
    parentSessionId: string;
    requestId: string;
    message: string;
  }): Promise<CloudSupervisorRequest> {
    const message = boundedMessage(input.message, "Supervisor reply");
    await this.#database.transaction().execute(async (transaction) => {
      const request = await transaction
        .selectFrom("subagent_supervisor_requests as request")
        .innerJoin("subagent_executions as execution", (join) =>
          join
            .onRef("execution.tenant_id", "=", "request.tenant_id")
            .onRef("execution.id", "=", "request.execution_id"),
        )
        .select([
          "request.reply_message as replyMessage",
          "execution.parent_session_id as parentSessionId",
        ])
        .where("request.tenant_id", "=", input.tenantId)
        .where("request.id", "=", input.requestId)
        .forUpdate(["request"])
        .executeTakeFirst();
      if (request === undefined || request.parentSessionId !== input.parentSessionId) {
        throw new SupervisorChannelError(
          "Supervisor request was not found for this parent Session",
        );
      }
      if (request.replyMessage !== null) {
        if (request.replyMessage !== message)
          throw new SupervisorChannelError("Supervisor request already has a different reply");
        return;
      }
      // This statement runs after the request lock. An earlier SELECT snapshot
      // (or the replying process's clock) cannot extend the deadline.
      const replied = await transaction
        .updateTable("subagent_supervisor_requests")
        .set({ reply_message: message, replied_at: sql<Date>`clock_timestamp()` })
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.requestId)
        .where("reply_message", "is", null)
        .where("expires_at", ">", sql<Date>`clock_timestamp()`)
        .returning("id")
        .executeTakeFirst();
      if (!replied) throw new SupervisorChannelError("Supervisor request has expired");
    });
    return this.request(input.tenantId, input.requestId);
  }
}
