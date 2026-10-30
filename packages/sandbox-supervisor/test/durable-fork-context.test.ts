import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { MemoryStorage, defineDoc, type StorageWrite } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { FORK_PROVENANCE_DOCUMENT } from "@pi-cloud/protocol";
import { DurableAgentSession } from "../src/durable/agent-session.ts";

const Provenance = defineDoc(FORK_PROVENANCE_DOCUMENT);

it.each([false, true])(
  "keeps Fork provenance out of effective instructions across reopen and compaction (old section: %s)",
  async (oldSection) => {
    const journal: StorageWrite[][] = [];
    class JournalStorage extends MemoryStorage {
      override async commit(writes: readonly StorageWrite[]) {
        const prepared = this.prepareCommit(writes);
        journal.push(structuredClone([...prepared.writes]));
        return prepared.apply();
      }
    }
    const restore = () => {
      const storage = new JournalStorage();
      for (const writes of journal) storage.prepareCommit(writes).apply();
      return storage;
    };
    const storage = new JournalStorage();
    const models = createModels(),
      provider = fauxProvider({ tokensPerSecond: 1_000_000 });
    models.setProvider(provider.provider);
    const sessionId = randomUUID(),
      sourceSessionId = randomUUID(),
      requests: string[] = [];
    const origin = { sessionId, sourceSessionId, sourceEntryId: "57" };
    const options = {
      models,
      remoteTools: [],
      settings: { compaction: { enabled: false, keepRecentTokens: 64 }, retry: { maxRetries: 0 } },
    };
    const bind = (runtime: DurableAgentSession) =>
      runtime.bind({
        runId: randomUUID(),
        conversationId: 1,
        model: provider.getModel(),
        agent: {},
        context: { sessionId },
        remoteTools: () => [],
        tools: [],
        assertCurrent: async () => {},
        openModel: async ({ options: request }) => ({
          model: provider.getModel(),
          options: request,
          release() {},
        }),
        prepareRemote: async () => {
          throw new Error("No Tool expected");
        },
      });
    const respond = () =>
      provider.setResponses([
        (request) => {
          requests.push(getCurrentSystemPrompt(request.messages));
          return fauxAssistantMessage("Done.");
        },
      ]);
    // Seed durable state, then close before the updated runner opens it. The old
    // section is a history fixture, not a retained production renderer.
    const seed = await DurableAgentSession.open(storage, options);
    try {
      const root = await bind(seed);
      await root.commit(async (tx) => {
        (await tx.doc(Provenance)).origin = origin;
        if (oldSection)
          await tx.appendEntry(root.id, {
            kind: "pi.system",
            model: [
              {
                role: "system",
                content: "",
                sections: { "fork-context": `This family was forked from ${sourceSessionId}.` },
                timestamp: 0,
              },
            ],
          });
      }, context);
    } finally {
      await seed.close();
    }
    const owner = await DurableAgentSession.open(restore(), options);
    const removals = () =>
      journal
        .flat()
        .filter(
          (write) =>
            write.type === "entry" &&
            write.value.kind === "pi.system" &&
            write.value.model?.some(
              (message) => message.role === "system" && message.sections?.["fork-context"] === null,
            ),
        );
    try {
      const root = await bind(owner);
      for (const text of ["Continue the chosen path.", "Continue again."]) {
        respond();
        expect(
          (await (await root.submit({ type: "input", content: text }, context)).wait(context))
            .status,
        ).toBe("done");
      }
      expect(removals()).toHaveLength(oldSection ? 1 : 0);
      provider.setResponses([fauxAssistantMessage("We continued the selected path.")]);
      await root.compact(undefined, context);
      await root.waitForIdle(context);
      respond();
      expect(
        (
          await (
            await root.submit({ type: "input", content: "After compaction." }, context)
          ).wait(context)
        ).status,
      ).toBe("done");
      expect(await owner.harness.snapshot(Provenance, context)).toEqual({ origin });
    } finally {
      await owner.close();
    }
    const restored = new MemoryStorage();
    for (const writes of journal) await restored.commit(writes, context);
    const reopened = await DurableAgentSession.open(restored, options);
    try {
      const root = await bind(reopened);
      respond();
      expect(
        (
          await (
            await root.submit({ type: "input", content: "After cold reopen." }, context)
          ).wait(context)
        ).status,
      ).toBe("done");
      expect(await reopened.harness.snapshot(Provenance, context)).toEqual({ origin });
      expect(requests).toHaveLength(4);
      for (const prompt of requests) {
        expect(prompt).not.toContain(sourceSessionId);
        expect(prompt).not.toContain("fork-context");
        expect(prompt).not.toContain("This family was forked");
      }
      expect(removals()).toHaveLength(oldSection ? 1 : 0);
    } finally {
      await reopened.close();
    }
  },
);
