import { afterEach, expect, it } from "vitest";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import { PostgresDurableSessionHost } from "@pi-cloud/pi-session-postgres/durable";
import { PublicationNotSentError } from "@pi-cloud/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { StorageWrite } from "@earendil-works/pi-durable";

const resources: Array<Awaited<ReturnType<typeof nativeSubagentFixture>>> = [];
afterEach(async () => {
  for (const f of resources.splice(0)) await f.close();
});
const entry = (id: number, conversationId = 1): StorageWrite => ({
  type: "entry",
  value: { id: id as never, conversationId: conversationId as never, kind: "test", data: "result" },
});

it("keeps the shared Host and native sequence usable after a proved no-send refusal", async () => {
  const f = await nativeSubagentFixture();
  resources.push(f);
  const host = new PostgresDurableSessionHost({ database: f.database });
  let reject = false,
    sent = 0;
  const publish = async ({
    commit,
    origins,
  }: Parameters<Parameters<typeof host.open>[0]["publish"]>[0]) => {
    if (reject) throw new PublicationNotSentError("Local queue refused this batch");
    sent++;
    await f.projection.apply(commit as never, origins);
  };
  const root = await host.open({
    binding: { ...f.scope, conversationId: 1, executionReference: f.reference },
    publish,
  });
  try {
    await root.storage.commit([{ type: "conversation", value: { id: 2 as never } }], context);
    const child = await host.open({
      binding: {
        ...f.scope,
        sessionId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        conversationId: 2,
        executionReference: f.reference,
      },
      publish,
    });
    const head = root.committedSequence();
    reject = true;
    await expect(root.storage.commit([entry(3)], context)).rejects.toMatchObject({
      name: "StorageRejected",
    });
    expect(root.committedSequence()).toBe(head);
    expect((await f.projection.head()).seq).toBe(head);
    expect(root.authority.signal.aborted).toBe(false);
    expect(child.authority.signal.aborted).toBe(false);
    reject = false;
    await child.storage.commit([entry(4, 2)], context);
    expect(root.committedSequence()).toBe(head + 1);
    expect(sent).toBe(2);
    expect(await root.storage.entry(1 as never, 3 as never, context)).toBeUndefined();
    expect(await child.storage.entry(2 as never, 4 as never, context)).toBeDefined();
    await Promise.all([child.close(), root.close()]);
  } finally {
    await host.close();
  }
}, 30000);

it.each(["unknown_ack", "lost_ack_after_commit", "effect_confirmation", "display_confirmation"])(
  "retires the Host after uncertain or post-ACK failure: %s",
  async (fault) => {
    const f = await nativeSubagentFixture();
    resources.push(f);
    const host = new PostgresDurableSessionHost({ database: f.database });
    let sent = 0;
    const handle = await host.open({
      binding: { ...f.scope, conversationId: 1, executionReference: f.reference },
      publish: async ({ commit, origins }) => {
        sent++;
        if (fault === "unknown_ack") throw new Error("Uncertain Kafka commit");
        await f.projection.apply(commit as never, origins);
        if (fault === "lost_ack_after_commit") throw new Error("Kafka committed but ACK was lost");
      },
    });
    const failAfterAck = () => {
      throw new PublicationNotSentError("Misclassified callback exception after ACK");
    };
    if (fault === "effect_confirmation")
      handle.preparePublication(() => ({ tools: [], cancellations: [], confirmed: failAfterAck }));
    if (fault === "display_confirmation")
      handle.prepareDisplay(() => ({ events: [], confirmed: failAfterAck }));
    try {
      await expect(handle.storage.commit([entry(2)], context)).rejects.not.toMatchObject({
        name: "StorageRejected",
      });
      expect(handle.authority.signal.aborted).toBe(true);
      expect(handle.authority.signal.reason).toMatchObject({ code: "writer_publication_failed" });
      expect(handle.committedSequence()).toBe(1);
      expect((await f.projection.head()).seq).toBe(fault === "unknown_ack" ? 1 : 2);
      await expect(handle.storage.commit([entry(3)], context)).rejects.toThrow();
      expect(sent).toBe(1);
    } finally {
      await host.close();
    }
  },
  30000,
);
