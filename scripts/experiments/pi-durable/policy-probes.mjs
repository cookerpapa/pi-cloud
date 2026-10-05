import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { JournalStorage, viewEntries } from "./journal.mjs";
import { openHarness, remoteAdapter, ctx, answer, call } from "./harness.mjs";
const batches = [];
const store = new JournalStorage(async (batch) => batches.push(batch));
const { harness, root } = await openHarness(store, {
  responses: [
    answer(call("remote", { value: "progress" }), { stopReason: "toolUse" }),
    answer("DONE"),
  ],
  execute: async (_args, api) => {
    for (let i = 0; i < 8; i++) {
      api.output(`PROBE_PREVIEW_${i}\n`);
      await delay(120);
    }
    return { content: [{ type: "text", text: "FINAL_ONLY" }] };
  },
});
await (await root.submit({ type: "input", content: "Probe durable output" }, ctx)).wait(ctx);
const entries = await viewEntries(harness, root.id);
const final = entries.find((e) => e.kind === "pi.tool-result");
assert.equal(final.model[0].content[0].text, "FINAL_ONLY");
const previews = batches.filter((b) => JSON.stringify(b).includes("PROBE_PREVIEW_"));
assert(previews.length > 0, "Expected native output() to be persisted");
await harness.close(ctx);
const adapter = remoteAdapter({
  submit: async (c, reply) =>
    reply({
      effect: c.call.arguments.value === "unknown" ? "unknown" : "completed",
      text: c.call.arguments.value,
      isError: c.call.arguments.value === "unknown",
    }),
  cancel: async () => {},
});
const mixedStore = new JournalStorage(
  async (_batch, commands) => {
    for (const c of commands) queueMicrotask(() => adapter.dispatch(c));
  },
  { commands: (b) => adapter.commands(b) },
);
const mixed = await openHarness(mixedStore, {
  execute: adapter.execute,
  hooks: adapter.hooks,
  responses: [
    answer(
      [
        call("remote", { value: "unknown" }, { id: "u" }),
        call("remote", { value: "success" }, { id: "s" }),
      ],
      { stopReason: "toolUse" },
    ),
    answer("MUST_NOT_SAMPLE"),
  ],
});
await (await mixed.root.submit({ type: "input", content: "mixed outcome round" }, ctx)).wait(ctx);
assert.equal(adapter.stats.blocked, true);
assert.equal(
  mixed.faux.state.callCount,
  2,
  "Upstream beforeRequest failure behavior changed; reevaluate the finding",
);
await mixed.harness.close(ctx);
const guardedAdapter = remoteAdapter({
  submit: async (c, reply) =>
    reply({
      effect: c.call.arguments.value === "unknown" ? "unknown" : "completed",
      text: c.call.arguments.value,
      isError: c.call.arguments.value === "unknown",
    }),
  cancel: async () => {},
});
const guardedStore = new JournalStorage(
  async (_batch, commands) => {
    for (const c of commands) queueMicrotask(() => guardedAdapter.dispatch(c));
  },
  { commands: (b) => guardedAdapter.commands(b) },
);
const guarded = await openHarness(guardedStore, {
  execute: guardedAdapter.execute,
  hooks: guardedAdapter.hooks,
  modelGuard: guardedAdapter.guard,
  responses: [
    answer(
      [
        call("remote", { value: "unknown" }, { id: "u" }),
        call("remote", { value: "success" }, { id: "s" }),
      ],
      { stopReason: "toolUse" },
    ),
    answer("MUST_NOT_SAMPLE"),
  ],
});
await (await guarded.root.submit({ type: "input", content: "mixed outcome round" }, ctx)).wait(ctx);
assert.equal(guarded.faux.state.callCount, 1, "The model-port guard failed to stop sampling");
await guarded.harness.close(ctx);
const report = {
  format: "pi-cloud.durable-output-probe.v1",
  version: "1.0.0",
  accepted: true,
  model: "scripted upstream faux provider",
  emittedPreviewChunks: 8,
  commits: batches.length,
  totalBatchBytes: batches.reduce((n, b) => n + Buffer.byteLength(JSON.stringify(b)), 0),
  commitsContainingPreview: previews.length,
  previewPresentInFinalToolContent: false,
  mixedToolRoundHookGuard: {
    executions: adapter.stats.operations.length,
    modelRequests: mixed.faux.state.callCount,
    compatible: false,
    finding:
      "Throwing from beforeRequest is reported and ignored; one terminating Tool does not end a mixed result round.",
  },
  mixedToolRoundModelPortGuard: {
    executions: guardedAdapter.stats.operations.length,
    modelRequests: guarded.faux.state.callCount,
    passed: true,
  },
  interpretation:
    "api.output() persists previews even when execute() supplies a different final result. Preserve PiCloud's lossy observation port; do not blindly bridge guest previews to this API. Counts are an immediate-ACK fixture, not fleet throughput.",
};
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
