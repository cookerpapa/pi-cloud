import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createSession, defineDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { HistoryStore } from "./store.mjs";
import { withDatabase, userEntry, append, all, drain } from "./fixture.mjs";
import { openNativeReader, referenceContext } from "./native-reader.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ids = (rows) => rows.map((r) => r.entry.id);
const assistant = (id, text, stopReason = "stop", extra = []) => ({
  id,
  conversationId: 1,
  kind: "pi.assistant",
  model: [
    {
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-6-luna",
      timestamp: 1,
      content: [{ type: "text", text }, ...extra],
      stopReason,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  ],
});

export async function contracts() {
  return withDatabase(async ({ pool, connectionString }) => {
    const results = [];
    const test = async (name, run) => {
      const at = performance.now();
      await run();
      const result = { name, passed: true, milliseconds: performance.now() - at };
      results.push(result);
      console.log(JSON.stringify(result));
    };
    await test("native Fork emits document copies rather than copying Entries", async () => {
      class Recorded extends MemoryStorage {
        async commit(writes, ctx) {
          this.last = structuredClone(writes);
          return super.commit(writes, ctx);
        }
      }
      const storage = new Recorded();
      await storage.commit([{ type: "conversation", value: { id: 1 } }], context);
      const session = createSession(storage);
      const docs = ["asOf", "current", "initial"].map((fork) =>
        defineDoc({
          kind: "lab." + fork,
          version: 1,
          scope: "conversation",
          history: "rewindable",
          fork,
          initial: () => ({ value: "initial" }),
        }),
      );
      try {
        await session.commit(async (tx) => {
          for (const doc of docs) (await tx.doc(doc, 1)).value = "before";
        }, context);
        const anchor = await session.commit(
          (tx) => tx.appendEntry(1, { kind: "fixture.entry", model: userEntry(2, "anchor").model }),
          context,
        );
        await session.commit(async (tx) => {
          for (const doc of docs) (await tx.doc(doc, 1)).value = "after";
        }, context);
        const fork = await session.commit(
          (tx) => tx.forkConversation(1, anchor.id, { ownership: { kind: "ownerless" } }),
          context,
        );
        assert.equal(storage.last.filter((w) => w.type === "entry").length, 0);
        assert.equal(storage.last.filter((w) => w.type === "document.copy").length, 2);
        const records = (
          await storage.scanDocuments(
            { scope: { kind: "conversation", conversationId: fork.id }, at: "current" },
            10,
            undefined,
            context,
          )
        ).items;
        const values = {};
        for (const r of records)
          values[r.kind] = (await storage.document(r.id, "current", context)).value.value;
        assert.deepEqual(values, { "lab.asOf": "before", "lab.current": "after" });
        assert.equal((await storage.entry(fork.id, anchor.id, context)).entry.id, anchor.id);
      } finally {
        await session.close(context);
      }
    });
    await test("native Storage permits reserved Entry IDs to commit out of order", async () => {
      const storage = new MemoryStorage();
      try {
        await storage.commit([{ type: "conversation", value: { id: 1 } }], context);
        const first = await storage.mintId(),
          second = await storage.mintId();
        await storage.commit(
          [{ type: "entry", value: userEntry(second, "second ID commits first") }],
          context,
        );
        await storage.commit(
          [{ type: "entry", value: userEntry(first, "first ID commits later") }],
          context,
        );
        assert(
          (await storage.entry(first, context)).commitSeq >
            (await storage.entry(second, context)).commitSeq,
        );
      } finally {
        await storage.close(context);
      }
    });
    await test("independent prefixes, presentation, images, exact tail collection and read pins", async () => {
      const store = new HistoryStore(pool),
        tenant = randomUUID(),
        source = await store.create(tenant);
      const c = randomUUID(),
        e = randomUUID(),
        upload = randomUUID(),
        uploadPin = randomUUID();
      await pool.query(
        "insert into lab_assets(id,tenant,bytes) values($1,$4,$5),($2,$4,$6),($3,$4,$7)",
        [
          c,
          e,
          upload,
          tenant,
          Buffer.from("C image"),
          Buffer.from("E image"),
          Buffer.from("pending upload"),
        ],
      );
      await pool.query("insert into lab_asset_pins(id,asset) values($1,$2)", [uploadPin, upload]);
      await append(
        store,
        source,
        [2, 3, 4, 5, 6].map((id) => ({
          entry: userEntry(id, String.fromCharCode(63 + id)),
          presentation: { caption: `message ${id}` },
          assets: id === 4 ? [c] : id === 6 ? [e] : [],
        })),
      );
      const fork = await store.fork(tenant, source.id, 4, "fork");
      await append(store, fork, [userEntry(fork.next_id, "F")]);
      const stale = { ...source };
      const pruned = await store.prune(tenant, source.id, 3);
      await assert.rejects(
        append(store, stale, [userEntry(stale.next_id, "STALE")]),
        /Stale append/,
      );
      await append(store, pruned, [userEntry(pruned.next_id, "source new suffix")]);
      await drain(store, tenant, 2);
      assert.deepEqual(ids(await all(store, fork)), [2, 3, 4, 7]);
      assert.deepEqual(ids(await all(store, pruned)), [2, 3, 7]);
      assert.equal((await store.asset(tenant, fork.id, c)).toString(), "C image");
      await assert.rejects(store.asset(tenant, pruned.id, c), /outside/);
      assert.equal(
        (await pool.query("select count(*)::int n from lab_assets where id=$1", [e])).rows[0].n,
        0,
      );
      assert.equal((await all(store, fork))[2].presentation.caption, "message 4");
      await store.remove(tenant, source.id);
      const pin = await store.pin(tenant, fork.id);
      await store.remove(tenant, fork.id);
      await drain(store, tenant, 2);
      assert.deepEqual(ids(await all(store, fork, { pin })), [2, 3, 4, 7]);
      await store.unpin(tenant, pin);
      await drain(store, tenant, 2);
      assert.equal(
        (await pool.query("select count(*)::int n from lab_streams where tenant=$1", [tenant]))
          .rows[0].n,
        0,
      );
      assert.deepEqual(
        (await pool.query("select id from lab_assets where tenant=$1", [tenant])).rows.map(
          (r) => r.id,
        ),
        [upload],
      );
      await pool.query("delete from lab_asset_pins where id=$1", [uploadPin]);
      await drain(store, tenant);
      assert.equal(
        (await pool.query("select count(*)::int n from lab_assets where tenant=$1", [tenant]))
          .rows[0].n,
        0,
      );
    });
    await test("rollback and ambiguous successful commit preserve idempotency", async () => {
      const store = new HistoryStore(pool),
        tenant = randomUUID(),
        source = await store.create(tenant);
      await append(store, source, [userEntry(2, "A"), userEntry(3, "B")]);
      await assert.rejects(
        store.fork(tenant, source.id, 3, "rolled-back", {
          beforeCommit: () => {
            throw Error("injected abort");
          },
        }),
        /injected abort/,
      );
      assert.equal(
        (await pool.query("select count(*)::int n from lab_views where tenant=$1", [tenant]))
          .rows[0].n,
        1,
      );
      assert.equal(
        (await pool.query("select count(*)::int n from lab_nodes where tenant=$1", [tenant]))
          .rows[0].n,
        0,
      );
      await assert.rejects(
        store.fork(tenant, source.id, 3, "lost-ack", {
          afterCommit: () => {
            throw Error("commit reply lost");
          },
        }),
        /commit reply lost/,
      );
      const a = await store.fork(tenant, source.id, 3, "lost-ack"),
        b = await store.fork(tenant, source.id, 3, "lost-ack");
      assert.equal(a.id, b.id);
      await store.remove(tenant, source.id);
      assert.equal((await store.fork(tenant, source.id, 3, "lost-ack")).id, a.id);
      await assert.rejects(store.fork(tenant, source.id, 2, "lost-ack"), /changed request/);
      assert.deepEqual(ids(await all(store, a)), [2, 3]);
    });
    await test("concurrent same-key Fork, source deletion and collection", async () => {
      const store = new HistoryStore(pool),
        tenant = randomUUID(),
        source = await store.create(tenant);
      await append(store, source, [userEntry(2, "A"), userEntry(3, "B"), userEntry(4, "C")]);
      const entered = deferred(),
        release = deferred();
      let removed = false;
      const copying = store.fork(tenant, source.id, 3, "race", {
        beforeCommit: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      await entered.promise;
      const duplicate = store.fork(tenant, source.id, 3, "race");
      await store.collect(tenant);
      const removing = store.remove(tenant, source.id).then(() => {
        removed = true;
      });
      await pause(25);
      assert.equal(removed, false);
      release.resolve();
      const [a, b] = await Promise.all([copying, duplicate]);
      await removing;
      assert.equal(a.id, b.id);
      await drain(store, tenant);
      assert.deepEqual(ids(await all(store, a)), [2, 3]);
    });
    await test("source append cannot leak through a captured Fork", async () => {
      const store = new HistoryStore(pool),
        tenant = randomUUID(),
        source = await store.create(tenant);
      await append(store, source, [userEntry(2, "A"), userEntry(3, "B")]);
      const entered = deferred(),
        release = deferred();
      let appended = false;
      const copying = store.fork(tenant, source.id, 3, "snapshot", {
        beforeCommit: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      await entered.promise;
      const writing = append(store, source, [userEntry(4, "future")]).then(() => {
        appended = true;
      });
      await pause(25);
      assert.equal(appended, false);
      release.resolve();
      const fork = await copying;
      await writing;
      assert.deepEqual(ids(await all(store, fork)), [2, 3]);
      assert.deepEqual(ids(await all(store, source)), [2, 3, 4]);
    });
    await test("append replay, stale cursors and explicit ID-order limitation", async () => {
      const store = new HistoryStore(pool),
        tenant = randomUUID(),
        source = await store.create(tenant);
      const batch = {
        seq: 1,
        generation: 0,
        entries: [2, 3, 4].map((id) => userEntry(id, "v" + id)),
      };
      assert.equal(await store.append(tenant, source.id, batch), true);
      assert.equal(await store.append(tenant, source.id, batch), false);
      await assert.rejects(
        store.append(tenant, source.id, { ...batch, entries: [userEntry(2, "changed")] }),
        /changed bytes/,
      );
      const page = await store.page(tenant, source.id, { limit: 1 });
      assert(page.next);
      await store.prune(tenant, source.id, 3);
      await assert.rejects(
        store.page(tenant, source.id, { cursor: page.next }),
        /Stale history cursor/,
      );
      const newView = await store.create(tenant);
      await append(store, newView, [userEntry(20, "reserved gap")]);
      await assert.rejects(
        append(store, newView, [userEntry(19, "out of order")]),
        /ascending native/,
      );
    });
    await test("public Pi context equals native reference across compaction and edits", async () => {
      const store = new HistoryStore(pool),
        tenant = randomUUID(),
        source = await store.create(tenant);
      const replacement = assistant(8, "partial wording retained\n[interrupted]").model;
      const entries = [
        userEntry(2, "A\0\ud800"),
        assistant(3, "read", "toolUse", [
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "fixture" } },
        ]),
        userEntry(4, "queued B"),
        {
          id: 5,
          conversationId: 1,
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "read",
              isError: false,
              content: [{ type: "text", text: "read result" }],
              timestamp: 1,
            },
          ],
        },
        assistant(6, "C"),
        { ...userEntry(7, "summary of A"), kind: "pi.compaction", head: 3 },
        assistant(8, "partial wording", "aborted"),
        {
          id: 9,
          conversationId: 1,
          kind: "fixture.context-edit",
          edits: [{ target: 8, action: "replace", messages: replacement }],
        },
        userEntry(10, "fork here"),
      ];
      await append(store, source, entries);
      const fork = await store.fork(tenant, source.id, 10, "native-context");
      await append(store, source, [
        userEntry(11, "future"),
        { ...userEntry(12, "future summary"), kind: "pi.compaction", head: 10 },
      ]);
      const reader = await openNativeReader(store, tenant, fork.id, { pin: true });
      const expected = await referenceContext(entries);
      try {
        await store.remove(tenant, source.id);
        await drain(store, tenant);
        const actual = await reader.context();
        assert.deepEqual(actual.messages, expected.messages);
        assert.equal(actual.head.id, 7);
        assert.equal(actual.messages[2].role, "toolResult");
        assert(JSON.stringify(actual.messages).includes("partial wording retained"));
        assert(!JSON.stringify(actual.messages).includes("future summary"));
      } finally {
        await reader.close();
      }
    });
    await test("Fork does not read old bodies; corruption is found on access", async () => {
      const calls = [],
        store = new HistoryStore(pool, { observe: (event) => calls.push(event) }),
        tenant = randomUUID(),
        source = await store.create(tenant);
      await append(store, source, [userEntry(2, "old content"), userEntry(3, "anchor")]);
      await pool.query(
        "update lab_entries set body=body||' ' where stream=(select stream from lab_views where id=$1) and id=2",
        [source.id],
      );
      calls.length = 0;
      const fork = await store.fork(tenant, source.id, 3, "integrity");
      assert(calls.every((c) => c.rows.every((row) => !Object.hasOwn(row, "body"))));
      await assert.rejects(store.page(tenant, fork.id), /body integrity/);
      await pool.query("update lab_nodes set records=records+1 where id=$1", [fork.base]);
      await assert.rejects(store.page(tenant, fork.id), /directory integrity/);
    });
    await test("prefix metadata corruption rejects Fork atomically", async () => {
      const store = new HistoryStore(pool),
        tenant = randomUUID(),
        source = await store.create(tenant);
      await append(store, source, [userEntry(2, "A")]);
      await pool.query(
        "update lab_entries set prefix_records=prefix_records+1 where stream=(select stream from lab_views where id=$1)",
        [source.id],
      );
      await assert.rejects(store.fork(tenant, source.id, 2, "bad-metadata"), /metadata integrity/);
      assert.equal(
        (await pool.query("select count(*)::int n from lab_views where tenant=$1", [tenant]))
          .rows[0].n,
        1,
      );
    });
    await test("keyset rank validates its boundary metadata", async () => {
      const store = new HistoryStore(pool),
        tenant = randomUUID(),
        source = await store.create(tenant);
      await append(
        store,
        source,
        [2, 3, 4].map((id) => userEntry(id, "before")),
      );
      const child = await store.fork(tenant, source.id, 4, "child");
      await append(
        store,
        child,
        [5, 6, 7].map((id) => userEntry(id, "after")),
      );
      const grandchild = await store.fork(tenant, child.id, 7, "grandchild");
      await pool.query(
        "update lab_entries set prefix_records=prefix_records+1 where stream=$1 and id=6",
        [child.stream],
      );
      await assert.rejects(
        store.page(tenant, grandchild.id, { max: 6, limit: 1 }),
        /Cursor boundary integrity/,
      );
    });
    await test("nested directories stay balanced; keyset pages have no omissions", async () => {
      const store = new HistoryStore(pool),
        tenant = randomUUID();
      let current = await store.create(tenant);
      const expected = [];
      for (let n = 0; n < 128; n++) {
        const id = current.next_id;
        expected.push(id);
        await append(store, current, [userEntry(id, "item " + n)]);
        const next = await store.fork(tenant, current.id, id, "nested-" + n);
        await store.remove(tenant, current.id);
        current = next;
      }
      assert.deepEqual(ids(await all(store, current)), expected);
      const {
        rows: [shape],
      } = await pool.query(
        `select max(n.height)::int height,count(*) filter(where abs(l.height-r.height)>1)::int bad
        from lab_nodes n left join lab_nodes l on l.id=n.left_id left join lab_nodes r on r.id=n.right_id where n.tenant=$1`,
        [tenant],
      );
      assert.equal(shape.bad, 0);
      assert(shape.height <= 10);
      const middle = await store.fork(tenant, current.id, expected[63], "middle");
      assert.deepEqual(ids(await all(store, middle)), expected.slice(0, 64));
      await store.remove(tenant, current.id);
      await drain(store, tenant);
      assert.deepEqual(ids(await all(store, middle)), expected.slice(0, 64));
    });
    await test("reopen needs no old process or source view", async () => {
      const store = new HistoryStore(pool),
        tenant = randomUUID(),
        source = await store.create(tenant);
      await append(store, source, [userEntry(2, "durable prefix")]);
      const fork = await store.fork(tenant, source.id, 2, "reopen");
      await store.remove(tenant, source.id);
      await drain(store, tenant);
      const other = new Pool({ connectionString, max: 2 });
      try {
        const reopened = new HistoryStore(other);
        assert.deepEqual(ids(await all(reopened, fork)), [2]);
        await append(reopened, fork, [userEntry(fork.next_id, "after reopen")]);
        assert.equal((await all(reopened, fork)).length, 2);
      } finally {
        await other.end();
      }
    });
    await test("cancelled Fork rolls back, and tenant visibility stays scoped", async () => {
      const store = new HistoryStore(pool),
        tenant = randomUUID(),
        source = await store.create(tenant),
        abort = new AbortController();
      await append(store, source, [userEntry(2, "private")]);
      await assert.rejects(
        store.fork(tenant, source.id, 2, "cancelled", {
          signal: abort.signal,
          beforeCommit: () => abort.abort(Error("cancelled")),
        }),
        /cancelled/,
      );
      await assert.rejects(
        store.fork(randomUUID(), source.id, 2, "wrong-tenant"),
        /View is missing/,
      );
      assert.equal(
        (await pool.query("select count(*)::int n from lab_views where tenant=$1", [tenant]))
          .rows[0].n,
        1,
      );
    });
    return {
      accepted: true,
      cases: results,
      scope:
        "History directory and read-only native context; not full Storage or production transport conformance",
    };
  });
}
