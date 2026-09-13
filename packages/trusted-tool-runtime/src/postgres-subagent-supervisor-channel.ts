import { randomUUID } from "node:crypto";
import type { Database, SubagentSupervisorReason } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";

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
    throw new Error(`${label} is required`);
  }
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error(`${label} is too large`);
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
    childRunId: string;
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
      const execution = await transaction
        .selectFrom("subagent_executions as execution")
        .innerJoin("runs as child_run", (join) =>
          join
            .onRef("child_run.tenant_id", "=", "execution.tenant_id")
            .onRef("child_run.id", "=", "execution.child_run_id"),
        )
        .select(["execution.id", "execution.state", "child_run.state as childRunState"])
        .where("execution.tenant_id", "=", input.tenantId)
        .where("execution.child_session_id", "=", input.childSessionId)
        .where("execution.child_run_id", "=", input.childRunId)
        .forUpdate(["execution"])
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
      if (
        execution === undefined ||
        (execution.state !== "running" && execution.childRunState !== "running")
      ) {
        throw new Error("Subagent execution is not running");
      }
      if (execution.state !== "running") {
        await transaction
          .updateTable("subagent_executions")
          .set({ state: "running", updated_at: new Date() })
          .where("tenant_id", "=", input.tenantId)
          .where("id", "=", execution.id)
          .executeTakeFirstOrThrow();
      }
      const expiresAt = expectsReply ? new Date(Date.now() + REQUEST_TIMEOUT_MS) : null;
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
          expires_at: expiresAt,
          replied_at: null,
        })
        .returning(["created_at as createdAt"])
        .executeTakeFirstOrThrow();
      return resource({
        id: requestId,
        executionId: execution.id,
        reason: input.reason,
        message,
        expectsReply,
        createdAt: row.createdAt,
        expiresAt,
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
            expression("expires_at", ">", sql<Date>`now()`),
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
      .where("request.expires_at", ">", sql<Date>`now()`)
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
      throw new Error("Supervisor request was not found for this parent Session");
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
          "request.expires_at as expiresAt",
          "execution.parent_session_id as parentSessionId",
        ])
        .where("request.tenant_id", "=", input.tenantId)
        .where("request.id", "=", input.requestId)
        .forUpdate(["request"])
        .executeTakeFirst();
      if (request === undefined || request.parentSessionId !== input.parentSessionId) {
        throw new Error("Supervisor request was not found for this parent Session");
      }
      if (request.replyMessage !== null) {
        if (request.replyMessage !== message)
          throw new Error("Supervisor request already has a different reply");
        return;
      }
      if (request.expiresAt === null || request.expiresAt.valueOf() <= Date.now()) {
        throw new Error("Supervisor request has expired");
      }
      await transaction
        .updateTable("subagent_supervisor_requests")
        .set({ reply_message: message, replied_at: new Date() })
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.requestId)
        .where("reply_message", "is", null)
        .executeTakeFirstOrThrow();
    });
    return this.request(input.tenantId, input.requestId);
  }
}
