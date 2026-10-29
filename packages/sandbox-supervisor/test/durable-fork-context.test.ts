import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { MemoryStorage, defineDoc, type StorageWrite } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { FORK_PROVENANCE_DOCUMENT } from "@pi-cloud/protocol";
import { DurableAgentSession } from "../src/durable/agent-session.ts";

const Provenance = defineDoc(FORK_PROVENANCE_DOCUMENT);

it("persists native Fork identity once, restores it cold and rebuilds it after compaction", async () => {
  const journal: StorageWrite[][] = [];
  const storage = new (class extends MemoryStorage {
    override async commit(writes: readonly StorageWrite[]) {
      const prepared = this.prepareCommit(writes);
      journal.push(structuredClone([...prepared.writes]));
      return prepared.apply();
    }
  })();
  const models = createModels(),
    provider = fauxProvider({ tokensPerSecond: 1_000_000 });
  models.setProvider(provider.provider);
  const sessionId = randomUUID(),
    sourceSessionId = randomUUID(),
    requests: string[] = [];
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
        requests.push(JSON.stringify(request.messages));
        return fauxAssistantMessage("Done.");
      },
    ]);
  const owner = await DurableAgentSession.open(storage, options);
  try {
    const root = await bind(owner);
    await root.commit(async (tx) => {
      (await tx.doc(Provenance)).origin = { sessionId, sourceSessionId, sourceEntryId: "57" };
    }, context);
    for (const text of ["Continue the chosen path.", "Continue again."]) {
      respond();
      expect(
        (await (await root.submit({ type: "input", content: text }, context)).wait(context)).status,
      ).toBe("done");
    }
    const forkSections = () =>
      journal
        .flat()
        .filter(
          (write) =>
            write.type === "entry" &&
            write.value.kind === "pi.system" &&
            JSON.stringify(write).includes("source family's agent instances"),
        );
    expect(forkSections()).toHaveLength(1);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toContain(sourceSessionId);
      expect(request).toContain("historical references, not live agents");
    }
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
    expect(requests.at(-1)).toContain(sourceSessionId);
    expect(forkSections()).toHaveLength(2);
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
    expect(requests.at(-1)).toContain(sourceSessionId);
    expect(await reopened.harness.snapshot(Provenance, context)).toEqual({
      origin: { sessionId, sourceSessionId, sourceEntryId: "57" },
    });
  } finally {
    await reopened.close();
  }
});
