import { unbindSessionTargets } from "./unbind-session-targets.ts";
import type { Database } from "@pi-cloud/database";
import {
  deletePostgresPiSessionsInTransaction,
  NativeSessionError,
} from "@pi-cloud/pi-session-postgres";
import { sql, type Kysely, type Transaction } from "kysely";

export class ConversationDeletionError extends Error {
  readonly code = "conflict";
  constructor(message: string) {
    super(message);
    this.name = "ConversationDeletionError";
  }
}

export class ConversationDeletionService {
  constructor(readonly options: { database: Kysely<Database> }) {}

  async delete(tenantId: string, sessionId: string): Promise<void> {
    try {
      await this.options.database.transaction().execute(async (transaction) => {
        const root = await transaction
          .selectFrom("sessions")
          .select(["id", "session_kind"])
          .where("tenant_id", "=", tenantId)
          .where("id", "=", sessionId)
          .forUpdate()
          .executeTakeFirst();
        if (!root) return;
        if (root.session_kind !== "conversation")
          throw new ConversationDeletionError(
            "Delegated conversations are deleted with their parent",
          );
        const original = await this.#tree(transaction, tenantId, sessionId);
        const ids = original.map((row) => row.id);
        const locked = await transaction
          .selectFrom("sessions")
          .select(["id", "state", "pi_session_id"])
          .where("tenant_id", "=", tenantId)
          .where(sql<boolean>`id=any(${ids}::uuid[])`)
          .orderBy("id")
          .forUpdate()
          .noWait()
          .execute();
        const current = await this.#tree(transaction, tenantId, sessionId);
        const lockedIds = new Set(locked.map((row) => row.id));
        if (current.length !== lockedIds.size || current.some((row) => !lockedIds.has(row.id)))
          throw new ConversationDeletionError(
            "Conversation tree changed during deletion; retry the request",
          );
        if (locked.some((row) => !["cold", "idle", "failed"].includes(row.state)))
          throw new ConversationDeletionError("An active conversation cannot be deleted");
        const unsettled = await transaction
          .selectFrom("runs")
          .select("id")
          .where("tenant_id", "=", tenantId)
          .where(sql<boolean>`session_id=any(${ids}::uuid[])`)
          .where((eb) =>
            eb.or([
              eb("state", "in", ["queued", "running", "settling", "cancel_requested"]),
              eb.and([eb("lease_id", "is not", null), eb("output_sealed_at", "is", null)]),
            ]),
          )
          .limit(1)
          .executeTakeFirst();
        if (unsettled)
          throw new ConversationDeletionError("Conversation has unfinished or unsealed work");
        const children = await transaction
          .selectFrom("subagent_executions")
          .select("id")
          .where("tenant_id", "=", tenantId)
          .where(sql<boolean>`child_session_id=any(${ids}::uuid[])`)
          .where("state", "in", ["preparing", "running"])
          .limit(1)
          .executeTakeFirst();
        if (children) throw new ConversationDeletionError("Delegated work is still active");
        await unbindSessionTargets(transaction, tenantId, ids);

        await transaction
          .deleteFrom("outbox")
          .where("tenant_id", "=", tenantId)
          .where("aggregate_type", "=", "session_terminal_event")
          .where(
            "id",
            "in",
            transaction
              .selectFrom("runs")
              .select("output_seal_id")
              .where("tenant_id", "=", tenantId)
              .where(sql<boolean>`session_id=any(${ids}::uuid[])`)
              .where("output_seal_id", "is not", null),
          )
          .execute();
        await transaction
          .deleteFrom("sessions")
          .where("tenant_id", "=", tenantId)
          .where(sql<boolean>`id=any(${ids}::uuid[])`)
          .execute();
        await deletePostgresPiSessionsInTransaction(transaction, tenantId, [
          ...new Set(locked.map((row) => row.pi_session_id)),
        ]);
        await sql`select pg_notify('pi_cloud_workspace_cleanup', '')`.execute(transaction);
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "55P03")
        throw new ConversationDeletionError(
          "Conversation is changing; retry deletion after it settles",
        );
      if (error instanceof NativeSessionError) throw new ConversationDeletionError(error.message);
      throw error;
    }
  }

  async #tree(transaction: Transaction<Database>, tenantId: string, sessionId: string) {
    return (
      await sql<{ id: string }>`with recursive tree as (
      select id,pi_session_id from sessions where tenant_id=${tenantId}::uuid and id=${sessionId}::uuid
      union
      select child.id,child.pi_session_id from sessions child join tree parent
        on child.conversation_parent_session_id=parent.id or
          (child.session_kind='subagent' and child.pi_session_id=parent.pi_session_id)
      where child.tenant_id=${tenantId}::uuid
    ) select id from tree order by id`.execute(transaction)
    ).rows;
  }
}
