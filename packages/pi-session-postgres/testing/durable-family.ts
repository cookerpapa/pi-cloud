import {
  Harness,
  createRegistry,
  type Conversation,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Message } from "@earendil-works/pi-ai";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import {
  DurablePostgresProjection,
  PublishedDurableStorage,
} from "@pi-cloud/pi-session-postgres/durable";

/** Native data fixture for cloud orchestration tests. It never schedules an
 * Agent; actual ownership/effect gating is covered by the Runner contract tests. */
export async function durableFamilyFixture(
  database: Kysely<Database>,
  tenantId: string,
  sessionId: string,
) {
  const bindings = new Map<number, { sessionId: string; runId: string; turnId: string }>();
  const anchors = new Map<string, { conversationId: number; at: number | undefined }>();
  const receipts = new Map<string, number>();
  const projection = new DurablePostgresProjection(database, { tenantId, sessionId });
  const storage = await PublishedDurableStorage.open({
    projection,
    publish: async (batch) => {
      const origins = batch.writes.flatMap((write) => {
        if (!("value" in write) || !("conversationId" in write.value)) return [];
        const scope = bindings.get(write.value.conversationId);
        return scope ? [{ ...scope, recordId: write.value.id }] : [];
      });
      await projection.apply(batch, origins, {
        topic: "native-family-fixture",
        partition: 0,
        offset: BigInt(batch.seq),
      });
    },
    waitProjected: async () => {},
  });
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  await harness.root(BACKGROUND_CONTEXT);
  return {
    harness,
    storage,
    projection,
    async bind(
      id: number | string | null,
      turnId: string,
      reference?: string,
    ): Promise<Conversation> {
      const conversationId = Number(id);
      const row = await database
        .selectFrom("runs")
        .select(["id", "session_id"])
        .where("tenant_id", "=", tenantId)
        .where("turn_id", "=", turnId)
        .executeTakeFirstOrThrow();
      bindings.set(conversationId, { turnId, runId: row.id, sessionId: row.session_id });
      const conversation = await harness.conversation(
        conversationId as ConversationId,
        BACKGROUND_CONTEXT,
      );
      if (!conversation) throw new Error("Fixture native conversation is missing");
      if (reference && !anchors.has(reference))
        anchors.set(reference, {
          conversationId,
          at: (await conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id,
        });
      return conversation;
    },
    nativeConversations: {
      childAnchor: async (reference: string, inherit: boolean) => {
        const anchor = anchors.get(reference);
        if (!anchor) throw new Error("Fixture owner is not bound");
        return inherit && anchor.at !== undefined ? String(anchor.at) : null;
      },
      createChildConversation: async (input: {
        executionReference: string;
        requestId: string;
        ownerTaskId: number;
        at: string | null;
      }) => {
        const prior = receipts.get(input.requestId);
        if (prior) return prior;
        const parent = anchors.get(input.executionReference);
        if (!parent) throw new Error("Fixture owner is not bound");
        const conversation =
          input.at === null
            ? await harness.createConversation(
                { ownership: { kind: "ownerless" } },
                BACKGROUND_CONTEXT,
              )
            : await (await harness.conversation(
                parent.conversationId as ConversationId,
                BACKGROUND_CONTEXT,
              ))!.fork(
                Number(input.at) as import("@earendil-works/pi-durable").EntryId,
                { ownership: { kind: "ownerless" } },
                BACKGROUND_CONTEXT,
              );
        receipts.set(input.requestId, conversation.id);
        return conversation.id;
      },
    },
    close: () => harness.close(BACKGROUND_CONTEXT),
  };
}
export async function appendFixtureMessage(conversation: Conversation, message: Message) {
  return conversation.commit(
    (tx) =>
      tx.appendEntry(conversation.id, {
        kind: `pi.${message.role === "toolResult" ? "tool-result" : message.role}`,
        model: [message],
      }),
    BACKGROUND_CONTEXT,
  );
}
