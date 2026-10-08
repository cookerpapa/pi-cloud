import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { MemoryStorage, type StorageWrite, type Seq } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import type { NativeHumanInput, NativeInputMutation } from "@pi-cloud/protocol";
import { DurableAgentSession } from "../src/durable/agent-session.ts";
import { DurableHumanInputs, HumanInputDocument } from "../src/durable/human-inputs.ts";

async function fixture() {
  const writes: StorageWrite[][] = [];
  const storage = new (class extends MemoryStorage {
    override async commit(batch: readonly StorageWrite[], _context: Context): Promise<Seq> {
      const prepared = this.prepareCommit(batch);
      writes.push(structuredClone([...prepared.writes]));
      return prepared.apply();
    }
  })();
  const faux = fauxProvider({ tokensPerSecond: 1_000_000 }),
    models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("first answer"),
    fauxAssistantMessage("next answer"),
    fauxAssistantMessage("last answer"),
  ]);
  const entered = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>();
  const calls: string[] = [];
  const runtime = await DurableAgentSession.open(storage, {
    models,
    remoteTools: [],
    settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
  });
  const runId = randomUUID();
  let accepting = true,
    current = true;
  const assertCurrent = async () => {
    if (!current) throw new Error("old owner");
  };
  const conversation = await runtime.bind({
    runId,
    conversationId: 1,
    model: faux.getModel(),
    agent: {},
    context: { sessionId: randomUUID(), turnId: randomUUID() },
    remoteTools: [],
    tools: [
      {
        name: "hold",
        description: "Test-only gate",
        parameters: Type.Object({}),
        execute: async () => {
          entered.resolve();
          await gate.promise;
          return { content: [{ type: "text", text: "released" }] };
        },
      },
    ],
    assertCurrent,
    prepareRemote: async () => {
      throw new Error("No remote transport expected");
    },
    openModel: async ({ input, options }) => {
      calls.push(JSON.stringify(input));
      return { model: faux.getModel(), options, release: () => {} };
    },
  });
  const inputs = new DurableHumanInputs({
    conversation,
    runId,
    storage,
    sequence: () => writes.length,
    assertCurrent,
    accepting: () => accepting,
    prepare: async (text) => text,
  });
  await conversation.submit(
    { type: "input", content: "initial", requestId: runId },
    BACKGROUND_CONTEXT,
  );
  await entered.promise;
  return {
    inputs,
    runId,
    storage,
    writes,
    calls,
    runtime,
    conversation,
    mutate: (request: Omit<NativeInputMutation, "fingerprint">) =>
      inputs.mutate({
        ...request,
        fingerprint: createHash("sha256")
          .update(
            JSON.stringify({
              inputId: request.inputId,
              revision: request.revision,
              change: request.change,
            }),
          )
          .digest("hex"),
      }),
    closeAdmission: () => {
      accepting = false;
    },
    replaceOwner: () => {
      current = false;
    },
    release: async () => {
      gate.resolve();
      await conversation.waitForIdle(
        withAbortSignal(AbortSignal.timeout(5_000), BACKGROUND_CONTEXT),
      );
    },
    close: async () => {
      gate.resolve();
      await runtime.close();
    },
  };
}
function input(text: string): NativeHumanInput {
  return {
    inputId: randomUUID(),
    idempotencyKey: randomUUID(),
    fingerprint: createHash("sha256").update(text).digest("hex"),
    text,
    uploads: [],
    mode: "follow_up",
    acceptedAt: new Date().toISOString(),
  };
}

it("keeps edited follow-up in the native queue and delivers only the latest content", async () => {
  const f = await fixture();
  try {
    const draft = input("original draft");
    const accepted = await f.inputs.submit(draft);
    expect(accepted.queue.items.map((item) => item.text)).toEqual(["original draft"]);
    const edit: Omit<NativeInputMutation, "fingerprint"> = {
      operationId: randomUUID(),
      inputId: draft.inputId,
      revision: accepted.queue.revision,
      change: { action: "edit", text: "final draft" },
    };
    const changed = await f.mutate(edit);
    expect(changed.queue.items[0]?.text).toBe("final draft");
    expect((await f.mutate(edit)).replayed).toBe(true);
    expect((await f.inputs.submit(draft)).queue.items[0]?.text).toBe("final draft");
    const replay = new MemoryStorage();
    for (const batch of f.writes) await replay.commit(batch, BACKGROUND_CONTEXT);
    const queued = await replay.submissionByRequest(1 as never, draft.inputId, BACKGROUND_CONTEXT);
    expect(queued?.status).toBe("queued");
    const restoredInbox = await replay.findDocument(
      { kind: "pi.inbox", scope: { kind: "conversation", conversationId: 1 as never } },
      "current",
      BACKGROUND_CONTEXT,
    );
    expect(restoredInbox).toBeDefined();
    const restored = await replay.document(restoredInbox!.id, "current", BACKGROUND_CONTEXT);
    expect(JSON.stringify(restored?.value)).toContain("final draft");
    expect(JSON.stringify(restored?.value)).not.toContain("original draft");
    await f.release();
    expect(f.calls).toHaveLength(3);
    expect(f.calls[1]).not.toContain("final draft");
    expect(f.calls[2]).toContain("final draft");
    expect(f.calls.join("\n")).not.toContain("original draft");
    await expect(f.mutate({ ...edit, operationId: randomUUID() })).rejects.toMatchObject({
      code: "input_conflict",
    });
    expect((await f.mutate(edit)).replayed).toBe(true);
  } finally {
    await f.close();
  }
});

it("moves and promotes the same native submission without creating another execution", async () => {
  const f = await fixture();
  try {
    const first = input("first follow-up"),
      second = input("second follow-up");
    await f.inputs.submit(first);
    const accepted = await f.inputs.submit(second);
    const before = await f.storage.submissionByRequest(
      1 as never,
      second.inputId,
      BACKGROUND_CONTEXT,
    );
    const moved = await f.mutate({
      operationId: randomUUID(),
      inputId: second.inputId,
      revision: accepted.queue.revision,
      change: { action: "move", direction: "up" },
    });
    expect(moved.queue.items.map((item) => item.inputId)).toEqual([second.inputId, first.inputId]);
    const steered = await f.mutate({
      operationId: randomUUID(),
      inputId: second.inputId,
      revision: moved.queue.revision,
      change: { action: "steer" },
    });
    expect(steered.queue.items[0]?.status).toBe("steering");
    expect(
      (await f.storage.submissionByRequest(1 as never, second.inputId, BACKGROUND_CONTEXT))?.id,
    ).toBe(before?.id);
    await f.release();
    expect(f.calls[1]).toContain("second follow-up");
    expect(f.calls[1]).not.toContain("first follow-up");
    expect(f.calls[2]).toContain("first follow-up");
  } finally {
    await f.close();
  }
});

it("rejects stale edits and separates individual withdrawal from Stop withdrawal", async () => {
  const f = await fixture();
  try {
    const first = input("cancel individually"),
      second = input("return on Stop");
    const old = await f.inputs.submit(first);
    const queued = await f.inputs.submit(second);
    await expect(
      f.mutate({
        operationId: randomUUID(),
        inputId: first.inputId,
        revision: old.queue.revision,
        change: { action: "edit", text: "stale" },
      }),
    ).rejects.toMatchObject({ code: "input_conflict" });
    await f.mutate({
      operationId: randomUUID(),
      inputId: first.inputId,
      revision: queued.queue.revision,
      change: { action: "cancel" },
    });
    const state = await f.runtime.harness.snapshot(
      HumanInputDocument,
      1 as never,
      f.runId,
      BACKGROUND_CONTEXT,
    );
    expect(state?.inputs[first.inputId]?.cancelled).toBe(true);
    expect(state?.inputs[second.inputId]?.cancelled).toBe(false);
    const aborted = f.conversation.abort(BACKGROUND_CONTEXT);
    await f.release();
    await aborted;
    expect(
      await f.storage.submissionByRequest(1 as never, second.inputId, BACKGROUND_CONTEXT),
    ).toMatchObject({ status: "unanswered", reason: "aborted" });
  } finally {
    await f.close();
  }
});

it("rejects new input after admission closes and refuses a replaced owner", async () => {
  const f = await fixture();
  try {
    f.closeAdmission();
    await expect(f.inputs.submit(input("late"))).rejects.toMatchObject({ code: "input_closed" });
    f.replaceOwner();
    await expect(f.inputs.submit(input("old owner"))).rejects.toThrow("old owner");
  } finally {
    await f.close();
  }
});
