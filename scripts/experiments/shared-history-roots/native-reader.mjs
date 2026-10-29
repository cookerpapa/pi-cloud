// Only a native context-read fixture. MemoryStorage supplies an empty runtime
// state, not durable tasks/documents, and all Harness mutations are rejected.
import assert from "node:assert/strict";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

class HistoryReader extends MemoryStorage {
  constructor(store, tenant, view, pin) {
    super();
    this.store = store;
    this.tenant = tenant;
    this.view = view;
    this.pin = pin;
  }
  async initialize() {
    await super.commit([{ type: "conversation", value: { id: 1 } }], context);
  }
  commit() {
    throw Error("History fixture is read-only; it is not a complete Storage implementation");
  }
  mintId() {
    throw Error("History fixture cannot allocate native IDs");
  }
  async entry(first, second) {
    const id = typeof second === "number" ? second : first;
    if (typeof second === "number") assert.equal(first, 1);
    const result = await this.store.entry(this.tenant, this.view, id, { pin: this.pin });
    return result && { entry: result.entry, commitSeq: result.commitSeq };
  }
  async scanEntries(query, limit, cursor) {
    assert.equal(query.conversationId, 1);
    const result = await this.store.page(this.tenant, this.view, {
      pin: this.pin,
      limit,
      cursor,
      min: query.minEntryId,
      max: query.maxEntryId,
    });
    return {
      items: result.items.map((r) => r.entry),
      ...(result.next ? { next: result.next } : {}),
    };
  }
  findLatestHeadMarker(conversation, at) {
    assert.equal(conversation, 1);
    return this.store.latestHead(this.tenant, this.view, at, { pin: this.pin });
  }
  async close(ctx) {
    if (this.pin) {
      await this.store.unpin(this.tenant, this.pin);
      this.pin = undefined;
    }
    await super.close(ctx);
  }
}
export async function openNativeReader(store, tenant, view, { pin = false } = {}) {
  const reader = new HistoryReader(
    store,
    tenant,
    view,
    pin ? await store.pin(tenant, view) : undefined,
  );
  await reader.initialize();
  const harness = await Harness.open(
    reader,
    { models: createModels({ providers: [] }), registry: createRegistry() },
    context,
  );
  const conversation = await harness.conversation(1, context);
  return { context: () => conversation.context(context), close: () => harness.close(context) };
}
export async function referenceContext(entries) {
  const storage = new MemoryStorage();
  await storage.commit([{ type: "conversation", value: { id: 1 } }], context);
  await storage.commit(
    entries.map((entry) => ({ type: "entry", value: entry })),
    context,
  );
  const harness = await Harness.open(
    storage,
    { models: createModels({ providers: [] }), registry: createRegistry() },
    context,
  );
  try {
    return await (await harness.conversation(1, context)).context(context);
  } finally {
    await harness.close(context);
  }
}
