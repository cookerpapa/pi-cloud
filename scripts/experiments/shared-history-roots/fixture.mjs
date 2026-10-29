import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { HistoryStore } from "./store.mjs";

export async function withDatabase(use) {
  const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
  assert(endpoint, "Use scripts/run-with-test-postgres.mjs; no production connection is accepted");
  const admin = new Pool({ connectionString: endpoint, max: 1 });
  const name = "history_roots_" + randomUUID().replaceAll("-", "");
  let pool;
  try {
    await admin.query(`create database "${name}"`);
    const url = new URL(endpoint);
    url.pathname = "/" + name;
    pool = new Pool({ connectionString: url.toString(), max: 8 });
    await pool.query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
    return await use({
      pool,
      connectionString: url.toString(),
      store: (options) => new HistoryStore(pool, options),
    });
  } finally {
    await pool?.end();
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
  }
}
export const userEntry = (id, text) => ({
  id,
  conversationId: 1,
  kind: "pi.user",
  model: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }],
});
export async function append(store, view, entries) {
  await store.append(view.tenant, view.id, {
    seq: view.seq + 1,
    generation: view.generation,
    entries,
  });
  view.seq++;
  view.next_id = (entries.at(-1).entry ?? entries.at(-1)).id + 1;
}
export async function drain(store, tenant, limit = 64) {
  const total = { nodes: 0, records: 0, bytes: 0, assets: 0 };
  for (let i = 0; i < 10000; i++) {
    const step = await store.collect(tenant, limit);
    for (const k of Object.keys(total)) total[k] += step[k];
    if (Object.values(step).every((v) => v === 0)) return total;
  }
  throw Error("Collection failed to converge");
}
export async function all(store, view, options = {}) {
  const result = [];
  let cursor;
  do {
    const page = await store.page(view.tenant, view.id, { limit: 7, ...options, cursor });
    result.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return result.reverse();
}
