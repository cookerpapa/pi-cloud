import { receivingConversationRunId } from "@pi-cloud/runtime-core/run-readiness";
import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import { type ConversationUsageResource, parseModelRuntimeSnapshot } from "@pi-cloud/protocol";
import {
  DurablePostgresProjection,
  readNativeUsageBatch,
  readNativeContextEstimate,
  emptyUsageTokens,
  addUsageTokens,
} from "@pi-cloud/pi-session-postgres/durable";
import { catalogModel } from "./runtime-model-catalog.ts";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

export async function readConversationUsage(
  database: Kysely<Database>,
  tenantId: string,
  sessionId: string,
): Promise<ConversationUsageResource> {
  if (!database.isTransaction)
    return database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute((tx) => readConversationUsage(tx, tenantId, sessionId));
  const session = await database
    .selectFrom("sessions as s")
    .innerJoin("model_profiles as m", (join) =>
      join
        .onRef("m.tenant_id", "=", "s.tenant_id")
        .onRef("m.id", "=", "s.desired_model_profile_id"),
    )
    .select([
      "s.id",
      "s.pi_session_id",
      "s.pi_conversation_id",
      "s.title",
      "s.session_kind",
      "m.provider",
      "m.model_id",
    ])
    .where("s.tenant_id", "=", tenantId)
    .where("s.id", "=", sessionId)
    .where("s.pruned_at", "is", null)
    .executeTakeFirst();
  if (!session) throw new ControlPlaneStoreError("not_found", "Conversation was not found");
  const active = await database
    .selectFrom("conversation_turns as c")
    .innerJoin("runs as r", (join) =>
      join.onRef("r.tenant_id", "=", "c.tenant_id").onRef("r.id", "=", "c.id"),
    )
    .select(["r.provider", "r.model_id", "r.model_runtime_snapshot"])
    .where("c.tenant_id", "=", tenantId)
    .where("c.session_id", "=", sessionId)
    .where("c.state", "in", ["queued", "running", "settling", "cancel_requested"])
    .$if(session.pi_conversation_id === null || Number(session.pi_conversation_id) === 1, (q) =>
      q.where("r.id", "=", receivingConversationRunId(tenantId, sessionId)),
    )
    .orderBy("c.mailbox_position", "desc")
    .limit(1)
    .executeTakeFirst();
  const model = {
    provider: active?.provider ?? session.provider,
    modelId: active?.model_id ?? session.model_id,
  };
  const runtime = active?.model_runtime_snapshot
    ? parseModelRuntimeSnapshot(active.model_runtime_snapshot)
    : catalogModel(model.provider, model.modelId);
  const family = await sql<{
    id: string;
    title: string;
    pi_session_id: string;
    pi_conversation_id: string | null;
  }>`with recursive family as (
    select id,title,pi_session_id,pi_conversation_id from sessions where tenant_id=${tenantId}::uuid and id=${sessionId}::uuid
    union
    select child.id,child.title,child.pi_session_id,child.pi_conversation_id from family parent
      join subagent_conversations link on link.tenant_id=${tenantId}::uuid and link.parent_session_id=parent.id
      join sessions child on child.tenant_id=link.tenant_id and child.id=link.child_session_id and child.pruned_at is null
      join runs root on root.tenant_id=link.tenant_id and root.id=link.root_run_id and root.pruned_at is null
  ) select * from family`.execute(database);
  const groups = new Map<string, typeof family.rows>();
  for (const item of family.rows) {
    const group = groups.get(item.pi_session_id) ?? [];
    group.push(item);
    groups.set(item.pi_session_id, group);
  }
  const usageBySession = new Map<
    string,
    { tokens: ConversationUsageResource["tokens"]; models: ConversationUsageResource["models"] }
  >();
  for (const [id, items] of groups) {
    const values = await readNativeUsageBatch(
      database,
      { tenantId, sessionId: id },
      items.map((item) => Number(item.pi_conversation_id ?? 1)),
    );
    for (const item of items)
      usageBySession.set(
        item.id,
        values.get(Number(item.pi_conversation_id ?? 1)) ?? {
          tokens: emptyUsageTokens(),
          models: [],
        },
      );
  }
  const own = usageBySession.get(sessionId) ?? { tokens: emptyUsageTokens(), models: [] };
  const children = family.rows
    .filter((item) => item.id !== sessionId)
    .map((item) => ({
      sessionId: item.id,
      title: item.title,
      tokens: usageBySession.get(item.id)!.tokens,
    }));
  const includingChildren = { ...own.tokens };
  for (const child of children) addUsageTokens(includingChildren, child.tokens);
  const scope = { tenantId, sessionId: session.pi_session_id };
  const head = await new DurablePostgresProjection(database, scope, undefined, "references").head();
  const context = await readNativeContextEstimate(database, {
    ...scope,
    conversationId: Number(session.pi_conversation_id ?? 1),
    ...model,
  });
  return {
    sessionId,
    nativeSequence: head.seq,
    observedAt: new Date().toISOString(),
    source: "postgres",
    inFlight: !!active,
    model,
    ...own,
    children,
    includingChildren,
    context: {
      ...context,
      window: runtime?.contextWindow ?? null,
      compactThreshold: runtime?.autoCompactTokenLimit ?? null,
    },
  };
}
