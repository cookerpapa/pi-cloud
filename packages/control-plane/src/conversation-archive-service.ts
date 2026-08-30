import type { Database } from "@pi-cloud/database";
import type { WorkspaceOperationResource } from "@pi-cloud/protocol";
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";

type ArchiveSessionRequest = Readonly<{ archived: boolean }>;

export type ConversationArchiveServiceOptions = {
  database: Kysely<Database>;
  clock?: () => Date;
  idGenerator?: () => string;
};

export type ConversationArchiveErrorCode = "not_found" | "conflict" | "idempotency_conflict";

export class ConversationArchiveError extends Error {
  readonly code: ConversationArchiveErrorCode;

  constructor(code: ConversationArchiveErrorCode, message: string) {
    super(message);
    this.name = "ConversationArchiveError";
    this.code = code;
  }
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Conversation archive clock returned an invalid Date");
  }
  return value;
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new ConversationArchiveError("conflict", "Stored timestamp is invalid");
  }
  return parsed.toISOString();
}

export class ConversationArchiveService {
  readonly #database: Kysely<Database>;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: ConversationArchiveServiceOptions) {
    this.#database = options.database;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async archive(
    tenantId: string,
    idempotencyKey: string,
    sessionId: string,
    request: ArchiveSessionRequest,
  ): Promise<WorkspaceOperationResource> {
    const kind = request.archived ? "archive" : "unarchive";
    const now = validDate(this.#clock);
    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const replay = await this.#operationReplay(
          transaction,
          tenantId,
          sessionId,
          idempotencyKey,
          kind,
        );
        if (replay !== undefined) return replay;
        const session = await transaction
          .selectFrom("sessions")
          .select([
            "state",
            "workspace_id",
            "execution_mode",
            "archived_at",
            "current_workspace_settlement_id",
            "conversation_parent_session_id",
          ])
          .where("tenant_id", "=", tenantId)
          .where("id", "=", sessionId)
          .forUpdate()
          .executeTakeFirst();
        if (session === undefined)
          throw new ConversationArchiveError("not_found", "Session was not found");
        if (!(["cold", "idle", "failed"] as const).some((state) => state === session.state)) {
          throw new ConversationArchiveError("conflict", "Active Session cannot be archived");
        }
        if ((session.archived_at !== null) === request.archived) {
          throw new ConversationArchiveError("conflict", "Session archive state already matches");
        }
        await this.#assertNoUnsettledTurns(transaction, tenantId, sessionId);
        let descendantSessionIds: string[] = [];
        if (request.archived) {
          const descendants = await sql<{ id: string; state: string }>`
            with recursive family as (
              select child.id, child.state
                from sessions child
               where child.tenant_id = ${tenantId}::uuid
                 and child.conversation_parent_session_id = ${sessionId}::uuid
                 and child.session_kind = 'conversation'
                 and child.archived_at is null
              union
              select child.id, child.state
                from sessions child
                join family parent on child.conversation_parent_session_id = parent.id
               where child.tenant_id = ${tenantId}::uuid
                 and child.session_kind = 'conversation'
                 and child.archived_at is null
            )
            select id, state from family
          `.execute(transaction);
          descendantSessionIds = descendants.rows.map((row) => row.id);
          if (
            descendants.rows.some(
              (row) => row.state !== "cold" && row.state !== "idle" && row.state !== "failed",
            )
          ) {
            throw new ConversationArchiveError("conflict", "A child conversation is still active");
          }
          if (descendantSessionIds.length > 0) {
            const unsettledDescendant = await transaction
              .selectFrom("turns")
              .select("id")
              .where("tenant_id", "=", tenantId)
              .where("session_id", "in", descendantSessionIds)
              .where("pruned_at", "is", null)
              .where("state", "in", ["queued", "running", "cancelling"])
              .limit(1)
              .executeTakeFirst();
            if (unsettledDescendant !== undefined) {
              throw new ConversationArchiveError(
                "conflict",
                "A child conversation is still active",
              );
            }
          }
          const activeSubagent = await transaction
            .selectFrom("subagent_executions")
            .select("id")
            .where("tenant_id", "=", tenantId)
            .where("root_session_id", "in", [sessionId, ...descendantSessionIds])
            .where("state", "in", ["preparing", "queued", "running"])
            .limit(1)
            .executeTakeFirst();
          if (activeSubagent !== undefined) {
            throw new ConversationArchiveError("conflict", "Delegated work is still active");
          }
        }
        if (!request.archived) {
          const parent =
            session.conversation_parent_session_id === null
              ? undefined
              : await transaction
                  .selectFrom("sessions")
                  .select("archived_at")
                  .where("tenant_id", "=", tenantId)
                  .where("id", "=", session.conversation_parent_session_id)
                  .executeTakeFirst();
          if (parent === undefined && session.conversation_parent_session_id !== null) {
            throw new ConversationArchiveError("not_found", "Parent conversation was not found");
          }
          if (parent?.archived_at !== null && parent !== undefined) {
            throw new ConversationArchiveError(
              "conflict",
              "Parent conversation must be restored before its child branch",
            );
          }
          await transaction
            .selectFrom("workspaces")
            .select("id")
            .where("tenant_id", "=", tenantId)
            .where("id", "=", session.workspace_id)
            .where("deleted_at", "is", null)
            .forUpdate()
            .executeTakeFirstOrThrow();
        }
        await transaction
          .updateTable("sessions")
          .set({
            archived_at: request.archived ? now : null,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
          })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", sessionId)
          .executeTakeFirstOrThrow();
        if (request.archived && descendantSessionIds.length > 0) {
          await transaction
            .updateTable("sessions")
            .set({
              archived_at: now,
              row_version: sql<string>`${sql.ref("row_version")} + 1`,
              updated_at: now,
            })
            .where("tenant_id", "=", tenantId)
            .where("id", "in", descendantSessionIds)
            .execute();
        }
        await transaction
          .updateTable("sessions")
          .set({
            archived_at: request.archived ? now : null,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
          })
          .where("tenant_id", "=", tenantId)
          .where(
            "id",
            "in",
            transaction
              .selectFrom("subagent_executions")
              .select("child_session_id")
              .where("tenant_id", "=", tenantId)
              .where("root_session_id", "in", [sessionId, ...descendantSessionIds]),
          )
          .execute();
        const operationId = this.#idGenerator();
        await transaction
          .insertInto("workspace_operations")
          .values({
            id: operationId,
            tenant_id: tenantId,
            session_id: sessionId,
            kind,
            idempotency_key: idempotencyKey,
            from_settlement_id: session.current_workspace_settlement_id,
            to_settlement_id: session.current_workspace_settlement_id,
            source_session_id: null,
          })
          .executeTakeFirstOrThrow();
        return {
          operationId,
          kind,
          sessionId,
          ...(session.current_workspace_settlement_id === null
            ? {}
            : { settlementId: session.current_workspace_settlement_id }),
          replayed: false,
          createdAt: now.toISOString(),
        };
      });
    } catch (error: unknown) {
      if (this.#isUnique(error, "workspace_operations_session_key_unique")) {
        return this.#loadOperation(tenantId, sessionId, idempotencyKey, kind, true);
      }
      throw error;
    }
  }

  async #assertNoUnsettledTurns(
    transaction: Transaction<Database>,
    tenantId: string,
    sessionId: string,
  ): Promise<void> {
    const active = await transaction
      .selectFrom("turns")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", sessionId)
      .where("state", "in", ["queued", "running", "cancelling"])
      .executeTakeFirst();
    if (active !== undefined) {
      throw new ConversationArchiveError("conflict", "Session has unsettled work");
    }
  }

  async #operationReplay(
    transaction: Transaction<Database>,
    tenantId: string,
    sessionId: string,
    idempotencyKey: string,
    expectedKind: "archive" | "unarchive",
  ): Promise<WorkspaceOperationResource | undefined> {
    const row = await transaction
      .selectFrom("workspace_operations as operation")
      .select([
        "operation.id",
        "operation.kind",
        "operation.session_id",
        "operation.to_settlement_id",
        "operation.created_at",
      ])
      .where("operation.tenant_id", "=", tenantId)
      .where("operation.session_id", "=", sessionId)
      .where("operation.idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    if (row.kind !== expectedKind) {
      throw new ConversationArchiveError(
        "idempotency_conflict",
        "Idempotency-Key was already used for a different Workspace operation",
      );
    }
    return {
      operationId: row.id,
      kind: expectedKind,
      sessionId: row.session_id,
      ...(row.to_settlement_id === null ? {} : { settlementId: row.to_settlement_id }),
      replayed: true,
      createdAt: iso(row.created_at),
    };
  }

  async #loadOperation(
    tenantId: string,
    sessionId: string,
    idempotencyKey: string,
    kind: "archive" | "unarchive",
    replayed: boolean,
  ): Promise<WorkspaceOperationResource> {
    const operation = await this.#database
      .transaction()
      .execute((transaction) =>
        this.#operationReplay(transaction, tenantId, sessionId, idempotencyKey, kind),
      );
    if (operation === undefined) {
      throw new ConversationArchiveError("conflict", "Workspace operation could not be replayed");
    }
    return { ...operation, replayed };
  }

  #isUnique(error: unknown, constraint: string): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505" &&
      "constraint" in error &&
      error.constraint === constraint
    );
  }
}
