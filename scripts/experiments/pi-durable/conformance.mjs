import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { JournalStorage } from "./journal.mjs";
import { ctx } from "./harness.mjs";
const tests = createStorageConformance({
  assertions: {
    ok: assert.ok,
    strictEqual: assert.strictEqual,
    deepEqual: assert.deepStrictEqual,
    partialDeepEqual: assert.partialDeepStrictEqual,
    greaterThan: (a, b) => assert(a > b),
    rejects: async (p, message) => assert.rejects(p, (e) => String(e.message).includes(message)),
  },
  withStorage: async (use) => {
    const store = new JournalStorage(async () => {});
    try {
      await use(store);
    } finally {
      await store.close(ctx);
    }
  },
});
const cases = [];
for (const t of tests) {
  try {
    await t.run();
    cases.push({ name: t.name, passed: true });
  } catch (e) {
    cases.push({ name: t.name, passed: false, error: e.message });
    process.exitCode = 1;
  }
}
const report = {
  format: "pi-cloud.durable-storage-conformance.v1",
  version: "1.0.0",
  passed: cases.filter((c) => c.passed).length,
  total: cases.length,
  scope:
    "Official upstream storage conformance on the public prepare/apply adapter, with an immediate in-memory publication ACK. RF3/PG transport is tested separately.",
  cases,
};
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
