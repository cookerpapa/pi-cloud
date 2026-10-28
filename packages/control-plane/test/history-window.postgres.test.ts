import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, it, expect } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { DurablePostgresProjection } from "@pi-cloud/pi-session-postgres/durable";
import {
  parseConversationDetailResource,
  HISTORY_PAGE_BYTES,
  type DurableRecordOrigin,
} from "@pi-cloud/protocol";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { ConversationTreeService } from "../src/conversation-tree-service.ts";
import { conversationMarkdown } from "@pi-cloud/runtime-core/conversation-markdown";

let db: Kysely<Database>, admin: Pool, name: string;
beforeAll(async () => {
  if (!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL) throw new Error("Use isolated PG runner");
  admin = new Pool({ connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL, max: 1 });
  name = "history_" + randomUUID().replaceAll("-", "");
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL);
  url.pathname = "/" + name;
  db = createDatabase({ connectionString: url.toString(), maxConnections: 4 });
  await runMigrations(db, "up");
}, 60000);
afterAll(async () => {
  await db?.destroy();
  if (admin) {
    await admin.query(`drop database "${name}"`);
    await admin.end();
  }
});
async function fixture() {
  const tenant = await createPrivateTenant(db, {
    slug: "history-" + randomUUID(),
    ownerDisplayName: "History window",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  const store = new ControlPlaneStore({ database: db, ...tenant });
  const project = await store.createProject({ name: "history", source: { kind: "empty" } });
  const session = await store.createSession(
    project.projectId,
    project.workspaceId,
    "history",
    "elastic",
  );
  const accepted = await store.acceptTurn(session.sessionId, randomUUID(), {
    prompt: "original input",
  });
  const native = await db
    .selectFrom("sessions")
    .select("pi_session_id")
    .where("id", "=", session.sessionId)
    .executeTakeFirstOrThrow();
  const projection = new DurablePostgresProjection(db, {
    tenantId: tenant.tenantId,
    sessionId: native.pi_session_id,
  });
  let sequence = 0,
    nextId = 2;
  const apply = async (writes: unknown[]) => {
    const origins: DurableRecordOrigin[] = writes.map((w: any) => ({
      recordId: w.value?.id ?? w.record?.id ?? w.id,
      runId: accepted.runId,
      turnId: accepted.turnId,
      sessionId: session.sessionId,
    }));
    await projection.apply({ seq: ++sequence, nextId, writes } as never, origins, {
      topic: "history-fixture",
      partition: 0,
      offset: BigInt(sequence),
    });
  };
  await apply([{ type: "conversation", value: { id: 1 } }]);
  const append = async (text: string) => {
    const id = nextId++;
    await apply([
      {
        type: "entry",
        value: {
          id,
          conversationId: 1,
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              content: [{ type: "text", text }],
              api: "openai-codex-responses",
              provider: "openai-codex",
              model: "gpt-6-luna",
              timestamp: Date.now(),
              stopReason: "stop",
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
        },
      },
    ]);
    return id;
  };
  const finish = () =>
    db
      .updateTable("runs")
      .set({
        state: "completed",
        started_at: new Date(),
        settled_at: new Date(),
        output_display_seq: String(sequence + 1),
        output_display_native_seq: String(sequence),
      })
      .where("id", "=", accepted.runId)
      .execute();
  return {
    tenant,
    store,
    session,
    accepted,
    append,
    apply,
    finish,
    projection,
    native,
    nextId: () => nextId,
    sequence: () => sequence,
    setId: (id: number) => {
      nextId = id;
    },
  };
}

it("pages inside one long Run in both directions and seeks an Entry without earlier bodies", async () => {
  const f = await fixture();
  const ids = [];
  for (let i = 0; i < 150; i++) ids.push(await f.append(`entry-${i}`));
  await f.finish();
  const latest = parseConversationDetailResource(
    await f.store.getConversation(f.session.sessionId),
  );
  expect(latest.turns).toHaveLength(1);
  expect(latest.turns[0]?.continuesBefore).toBe(true);
  expect(latest.history.hasBefore).toBe(true);
  expect(latest.history.hasAfter).toBe(false);
  expect(latest.turns[0]?.transcript?.items).toHaveLength(64);
  const previous = await f.store.getConversation(f.session.sessionId, {
    before: latest.history.before!,
  });
  expect(previous.turns[0]?.transcript?.items[0]).toMatchObject({ kind: "text", text: "entry-22" });
  const next = await f.store.getConversation(f.session.sessionId, {
    after: previous.history.after!,
  });
  expect(next.turns[0]?.transcript?.items).toEqual(latest.turns[0]?.transcript?.items);
  const first = await f.store.getConversation(f.session.sessionId, {
    before: previous.history.before!,
  });
  expect(first.history.hasBefore).toBe(false);
  expect(first.turns[0]?.prompt).toBe("original input");
  const around = await f.store.getConversation(f.session.sessionId, {
    turnId: f.accepted.turnId,
    entryId: String(ids[80]),
  });
  expect(around.turns[0]?.transcript?.items.at(-1)).toMatchObject({ text: "entry-80" });
}, 30000);

it("applies the byte budget before body fetching and retains every page", async () => {
  const f = await fixture();
  for (let i = 0; i < 40; i++) await f.append(`${i}:` + "x".repeat(180000));
  await f.finish();
  let page = await f.store.getConversation(f.session.sessionId),
    seen = 0;
  for (;;) {
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(HISTORY_PAGE_BYTES + 65536);
    seen += page.turns
      .flatMap((t) => t.transcript?.items ?? [])
      .filter((i) => i.kind === "text").length;
    if (!page.history.hasBefore) break;
    page = await f.store.getConversation(f.session.sessionId, { before: page.history.before! });
  }
  expect(seen).toBe(40);
}, 30000);

it("rejects a cursor or Entry outside the visible Session and preserves empty history", async () => {
  const a = await fixture(),
    b = await fixture();
  const id = await a.append("private");
  await a.finish();
  await b.finish();
  const view = await a.store.getConversation(a.session.sessionId);
  await expect(
    b.store.getConversation(b.session.sessionId, { before: view.history.before! }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    b.store.getConversation(b.session.sessionId, {
      turnId: a.accepted.turnId,
      entryId: String(id),
    }),
  ).rejects.toMatchObject({ code: "not_found" });
  expect((await b.store.getConversation(b.session.sessionId)).turns[0]?.transcript?.items).toEqual(
    [],
  );
});

it("pairs off-page Tool arguments by Task even when provider call IDs repeat", async () => {
  const f = await fixture();
  const tasks: number[] = [];
  for (const path of ["first.ts", "second.ts"]) {
    const assistant = f.nextId(),
      task = assistant + 1;
    f.setId(task + 1);
    tasks.push(task);
    await f.apply([
      {
        type: "entry",
        value: {
          id: assistant,
          kind: "pi.assistant",
          conversationId: 1,
          model: [
            {
              role: "assistant",
              stopReason: "toolUse",
              content: [{ type: "toolCall", id: "same-call", name: "read", arguments: { path } }],
            },
          ],
        },
      },
      {
        type: "task",
        value: {
          id: task,
          kind: "pi.tool",
          conversationId: 1,
          version: 1,
          input: { assistant, callId: "same-call" },
          background: false,
          abortRequested: false,
          state: {
            status: "running",
            checkpoint: { phase: "execute", arguments: { path }, replay: "safe" },
          },
        },
      },
    ]);
  }
  for (let i = 0; i < 90; i++) await f.append("intervening " + i);
  // Results finish in the reverse order; neither the previous page nor the latest
  // assistant can substitute for this Task's original intent.
  for (const [index, task] of [...tasks].reverse().entries()) {
    const result = f.nextId();
    f.setId(result + 1);
    await f.apply([
      {
        type: "entry",
        value: {
          id: result,
          conversationId: 1,
          byTaskId: task,
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolCallId: "same-call",
              toolName: "read",
              content: [{ type: "text", text: "result " + index }],
              isError: false,
            },
          ],
        },
      },
      {
        type: "task",
        value: {
          id: task,
          kind: "pi.tool",
          conversationId: 1,
          version: 1,
          input: { assistant: task - 1, callId: "same-call" },
          background: false,
          abortRequested: false,
          state: {
            status: "terminal",
            outcome: { status: "completed", result: { entryId: result } },
          },
        },
      },
    ]);
  }
  await f.finish();
  const view = await f.store.getConversation(f.session.sessionId);
  const tools = view.turns
    .flatMap((t) => t.transcript?.items ?? [])
    .filter((i) => i.kind === "tool");
  expect(tools.map((i) => [i.toolCallId, i.input])).toEqual([
    [`task:${tasks[1]}`, { path: "second.ts" }],
    [`task:${tasks[0]}`, { path: "first.ts" }],
  ]);
});

it("reads only a consumed input's metadata slice, preserving JSON escapes and Unicode", async () => {
  const f = await fixture();
  const doc = f.nextId(),
    entry = doc + 1,
    submission = doc + 2;
  f.setId(submission + 1);
  const inputId = "input-" + "a".repeat(64),
    text = 'message with } braces, "quotes", 😀' + "汉".repeat(95000);
  const input = {
    idempotencyKey: "one",
    fingerprint: "a".repeat(64),
    text,
    uploads: [],
    acceptedAt: new Date().toISOString(),
    revision: 1,
    cancelled: false,
    nativeId: submission,
  };
  await f.apply([
    {
      type: "document.create",
      record: {
        id: doc,
        kind: "pi-cloud.human-inputs",
        version: 1,
        scope: { kind: "conversation", conversationId: 1 },
        key: f.accepted.runId,
        history: "latest",
        fork: "initial",
        createdAt: f.sequence() + 1,
      },
      content: {
        kind: "base",
        version: 1,
        value: {
          runId: f.accepted.runId,
          inputs: {
            [inputId]: input,
            "input-unrelated": { ...input, text: "\u0000\ud800" + "unrelated".repeat(100000) },
          },
          order: [inputId],
          receipts: {},
        },
      },
    },
    {
      type: "entry",
      value: {
        id: entry,
        kind: "pi.user",
        conversationId: 1,
        model: [{ role: "user", content: text, timestamp: Date.now() }],
      },
    },
    {
      type: "submission",
      value: {
        id: submission,
        conversationId: 1,
        type: "input",
        requestId: inputId,
        status: "done",
        entry,
      },
    },
  ]);
  await f.finish();
  const view = await f.store.getConversation(f.session.sessionId);
  expect(view.turns[0]?.transcript?.items.find((i) => i.kind === "user")).toMatchObject({
    inputId,
    text,
  });
  expect(JSON.stringify(view)).not.toContain("unrelated");
});

it("pages navigation captions and streams every completed message through one export", async () => {
  const f = await fixture();
  for (let i = 0; i < 170; i++) await f.append("export-" + i);
  await f.finish();
  const service = new ConversationTreeService({ database: db });
  const nav = await service.tree(f.tenant.tenantId, f.session.sessionId, "focus");
  expect(nav.branches[0]?.entries).toHaveLength(80);
  expect(nav.branches[0]?.earlierEntryId).toBeDefined();
  const old = await service.tree(f.tenant.tenantId, f.session.sessionId, "focus", {
    beforeEntryId: nav.branches[0]!.earlierEntryId!,
  });
  expect(old.branches[0]?.entries.at(-1)?.text).toBe("export-89");
  const parts = [];
  for await (const part of conversationMarkdown(f.store.completedHistoryPages(f.session.sessionId)))
    parts.push(part);
  const exported = parts.join("");
  expect(exported.match(/## Turn 1/g)).toHaveLength(1);
  for (let i = 0; i < 170; i++) expect(exported).toContain("export-" + i + "\n");
  expect(parts.length).toBeGreaterThan(170);
  let cursor: string | undefined,
    found = false;
  for (let i = 0; i < 5; i++) {
    const result = await f.store.searchConversation(f.session.sessionId, "export-7", cursor);
    if (result.results.some((r) => r.snippet === "export-7")) {
      found = true;
      break;
    }
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  expect(found).toBe(true);
}, 30000);

it("backfills disposable indexes without changing native history bodies or fingerprints", async () => {
  const before =
    await sql`select tenant_id,session_id,seq,ordinal,md5(body) as fingerprint from pi_durable_log order by tenant_id,session_id,seq,ordinal`.execute(
      db,
    );
  const fields =
    await sql`select tenant_id,session_id,id,fields from pi_durable_records where kind in ('entry','task') order by tenant_id,session_id,id`.execute(
      db,
    );
  const scopes = (
    await sql<{
      tenant_id: string;
      session_id: string;
    }>`select distinct tenant_id,session_id from pi_durable_commits`.execute(db)
  ).rows;
  for (const scope of scopes)
    await new DurablePostgresProjection(db, {
      tenantId: scope.tenant_id,
      sessionId: scope.session_id,
    }).rebuild();
  expect(
    (
      await sql`select tenant_id,session_id,seq,ordinal,md5(body) as fingerprint from pi_durable_log order by tenant_id,session_id,seq,ordinal`.execute(
        db,
      )
    ).rows,
  ).toEqual(before.rows);
  expect(
    (
      await sql`select tenant_id,session_id,id,fields from pi_durable_records where kind in ('entry','task') order by tenant_id,session_id,id`.execute(
        db,
      )
    ).rows,
  ).toEqual(fields.rows);
});
