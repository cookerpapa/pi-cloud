import { expect, it } from "vitest";
import {
  createRegistry,
  defineDocFamily,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { durableToolState } from "@pi-cloud/protocol";

const DispatchProbe = defineDocFamily<{ callId: string }, { callId: string }>({
  kind: "test.dispatch-probe",
  version: 1,
  scope: "task",
  family: true,
  initial: (value) => value,
});

it.each(["same_commit", "execute_commit"] as const)(
  "measures the public Pi handoff boundary (%s) without modifying the agent loop",
  async (mode) => {
    const journal: StorageWrite[][] = [];
    let intentSequence = -1,
      dispatchSequence = -1,
      executeCalls = 0;
    const storage = new (class extends MemoryStorage {
      override async commit(writes: readonly StorageWrite[]) {
        const prepared = this.prepareCommit(writes);
        const index = journal.length;
        journal.push(structuredClone([...writes]));
        if (writes.some((w) => w.type === "task" && durableToolState(w.value)?.intent)) {
          intentSequence = index;
          if (mode === "same_commit") dispatchSequence = index;
        }
        if (
          writes.some(
            (w) => w.type === "document.create" && w.record.kind === "test.dispatch-probe",
          )
        )
          dispatchSequence = index;
        return prepared.apply();
      }
    })();
    const models = createModels(),
      faux = fauxProvider({ tokensPerSecond: 1_000_000 });
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("probe", { text: "validated" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "native-publication-probe",
        tools: [
          defineTool({
            name: "probe",
            description: "In-memory SDK contract; no external effects",
            replay: "unsafe",
            parameters: Type.Object({ text: Type.String() }),
            execute: async (args, api, ctx) => {
              executeCalls++;
              expect(args.text).toBe("validated");
              expect(intentSequence).toBeGreaterThanOrEqual(0);
              if (mode === "execute_commit") {
                expect(dispatchSequence).toBe(-1);
                await api.commit(
                  (tx) => tx.doc(DispatchProbe, api.taskId, api.callId, { callId: api.callId }),
                  ctx,
                );
              }
              return { content: [{ type: "text", text: "result" }] };
            },
          }),
        ],
      }),
    );
    const harness = await Harness.open(
      storage,
      { models, registry, settings: { retry: { maxRetries: 0 }, compaction: { enabled: false } } },
      context,
    );
    try {
      const root = await harness.root(context, {
        agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } },
      });
      const submission = await root.submit({ type: "input", content: "Call probe" }, context);
      expect((await submission.wait(context)).status).toBe("done");
      expect(executeCalls).toBe(1);
      expect(dispatchSequence - intentSequence).toBe(mode === "same_commit" ? 0 : 1);
    } finally {
      await harness.close(context);
    }
  },
);
