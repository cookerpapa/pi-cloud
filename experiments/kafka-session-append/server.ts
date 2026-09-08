import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Admin, Producer, ProduceAcks, stringSerializers } from "@platformatic/kafka";
import { KafkaLogConsumer } from "@pi-cloud/event-log";
import type { NativeFact, NativeItem } from "./storage.ts";

const brokers = ["kafka-1:9092", "kafka-2:9092", "kafka-3:9092"];
const topic = process.env.EXPERIMENT_TOPIC!;
const pool = new pg.Pool({ connectionString: process.env.EXPERIMENT_DATABASE_URL, max: 8 });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.argv[2] === "projector") {
  const consumer = new KafkaLogConsumer<NativeFact>({
    brokers,
    topic,
    clientId: `projector-${randomUUID()}`,
    groupId: `experiment-${randomUUID()}`,
    commitMessages: false,
    decode: (bytes) => JSON.parse(bytes.toString()),
    replayOffsets: async (bounds) => {
      const rows = (await pool.query("select partition,position from offsets")).rows;
      return new Map(
        bounds.map((b) => [
          b.partition,
          BigInt(rows.find((r) => r.partition === b.partition)?.position ?? b.low),
        ]),
      );
    },
    handler: async ({ fact, partition, offset }) => {
      await delay(Number(process.env.EXPERIMENT_PROJECTION_DELAY_MS ?? 0));
      const db = await pool.connect();
      try {
        await db.query("begin");
        const hash = createHash("sha256").update(JSON.stringify(fact)).digest("hex");
        const existing = (await db.query("select hash from receipts where id=$1", [fact.id]))
          .rows[0];
        if (existing) assert.equal(existing.hash, hash, "duplicate Fact changed its body");
        else {
          await db.query("insert into heads(id,seq,lanes) values($1,0,$2) on conflict do nothing", [
            fact.sessionId,
            JSON.stringify({ main: null }),
          ]);
          const head = (
            await db.query("select seq,lanes from heads where id=$1 for update", [fact.sessionId])
          ).rows[0];
          const sealed =
            (
              await db.query("select 1 from seals where session_id=$1 and writer=$2", [
                fact.sessionId,
                fact.writerId,
              ])
            ).rowCount !== 0;
          if (!sealed) {
            if (fact.kind === "seal") {
              assert.equal(
                Number(head.seq),
                fact.through,
                "seal did not cover the complete prefix",
              );
              await db.query("insert into seals values($1,$2,$3)", [
                fact.sessionId,
                fact.writerId,
                fact.through,
              ]);
            } else {
              let seq = Number(head.seq);
              const lanes = head.lanes as Record<string, string | null>;
              for (const item of fact.items) {
                assert.equal(item.seq, ++seq, "non-consecutive canonical sequence");
                if (item.kind === "entry") {
                  assert.equal(item.entry.parentId, lanes[item.lane!], "canonical parent changed");
                  lanes[item.lane!] = item.entry.id;
                } else if (item.kind === "lane") lanes[item.lane!] = item.leafId;
              }
              if (fact.items.length) {
                const params = fact.items.flatMap((item) => [
                  fact.sessionId,
                  item.seq,
                  JSON.stringify(item),
                ]);
                const values = fact.items
                  .map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`)
                  .join(",");
                await db.query(`insert into entries(session_id,seq,item) values ${values}`, params);
              }
              await db.query("update heads set seq=$2,lanes=$3 where id=$1", [
                fact.sessionId,
                seq,
                JSON.stringify(lanes),
              ]);
            }
          }
          await db.query("insert into receipts values($1,$2,$3)", [
            fact.id,
            hash,
            sealed ? "excluded" : "applied",
          ]);
        }
        await db.query(
          "insert into offsets values($1,$2) on conflict(partition) do update set position=greatest(offsets.position,excluded.position)",
          [partition, String(offset + 1n)],
        );
        await db.query("select pg_notify('experiment_projected',$1)", [fact.id]);
        await db.query("commit");
      } catch (error) {
        await db.query("rollback");
        process.send?.({ error: error instanceof Error ? error.message : "projection failed" });
        throw error;
      } finally {
        db.release();
      }
    },
  });
  await consumer.start();
  process.send?.("ready");
} else {
  await pool.query(`
    create table heads(id text primary key,seq bigint not null,lanes jsonb not null);
    create table entries(session_id text not null,seq bigint not null,item jsonb not null,primary key(session_id,seq));
    create table receipts(id text primary key,hash text not null,status text not null);
    create table seals(session_id text not null,writer text not null,through bigint not null,primary key(session_id,writer));
    create table offsets(partition integer primary key,position bigint not null);
  `);
  const admin = new Admin({
    bootstrapBrokers: brokers,
    clientId: `experiment-admin-${randomUUID()}`,
  });
  await admin.createTopics({
    topics: [topic],
    partitions: 8,
    replicas: 3,
    configs: [
      { name: "min.insync.replicas", value: "2" },
      { name: "retention.ms", value: "3600000" },
    ],
  });
  const producer = new Producer({
    bootstrapBrokers: brokers,
    clientId: `experiment-producer-${randomUUID()}`,
    serializers: stringSerializers,
    idempotent: true,
    acks: ProduceAcks.ALL,
    autocreateTopics: false,
  });
  const notifications = new pg.Client({ connectionString: process.env.EXPERIMENT_DATABASE_URL });
  await notifications.connect();
  const pending = new Map<string, () => void>();
  notifications.on("notification", (event) => pending.get(event.payload!)?.());
  await notifications.query("listen experiment_projected");
  let child: ChildProcess | undefined;
  let childDiagnostic = "";
  const stop = async () => {
    if (!child) return;
    const target = child;
    child = undefined;
    if (target.exitCode !== null || target.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      target.once("exit", () => resolve());
      target.kill("SIGKILL");
    });
  };
  const start = async (delayMs: number) => {
    assert(!child, "projector already exists");
    const target = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url), "projector"],
      {
        env: { ...process.env, EXPERIMENT_PROJECTION_DELAY_MS: String(delayMs) },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    child = target;
    childDiagnostic = "";
    target.on("message", (message: unknown) => {
      if (message && typeof message === "object" && "error" in message)
        childDiagnostic = String(message.error).slice(-2000);
    });
    target.stderr!.on("data", (data) => {
      childDiagnostic = (childDiagnostic + data.toString()).slice(-2000);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("projector startup timed out")), 30000);
      target.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      target.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("projector exited during startup"));
      });
      target.once("message", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  const stats = { published: 0, baselineReceiptWaits: 0, fastReceiptWaits: 0 };
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${process.env.EXPERIMENT_TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    try {
      const url = new URL(request.url!, "http://experiment");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      let result: unknown = { ok: true };
      if (url.pathname === "/facts") {
        const fact = body as NativeFact;
        let done!: () => void;
        const receipt = new Promise<void>((resolve) => {
          done = resolve;
        });
        if (url.searchParams.has("wait_pg")) pending.set(fact.id, done);
        try {
          await producer.send({
            messages: [{ topic, key: fact.sessionId, value: JSON.stringify(fact) }],
            acks: ProduceAcks.ALL,
          });
          stats.published++;
          if (url.searchParams.has("drop_ack")) {
            response.destroy();
            return;
          }
          if (url.searchParams.has("wait_pg")) {
            stats.baselineReceiptWaits++;
            let timer: NodeJS.Timeout | undefined;
            try {
              await Promise.race([
                receipt,
                new Promise((_, reject) => {
                  timer = setTimeout(() => reject(new Error("projection wait timed out")), 30000);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          }
        } finally {
          pending.delete(fact.id);
        }
      } else if (url.pathname === "/projector/start") await start(body.delayMs ?? 0);
      else if (url.pathname === "/projector/kill") await stop();
      else if (url.pathname === "/state") {
        result = {
          stats,
          childDiagnostic,
          heads: (await pool.query("select * from heads")).rows,
          seals: (await pool.query("select * from seals")).rows,
          receipts: (await pool.query("select id,status from receipts")).rows,
        };
      } else if (url.pathname === "/external-pg-repair") {
        // Negative control: reproduce today's PG-owned seal repair while a
        // different Lane's Worker still allocates native sequence in memory.
        const db = await pool.connect();
        try {
          await db.query("begin");
          const head = (
            await db.query("select seq,lanes from heads where id=$1 for update", [body.sessionId])
          ).rows[0];
          const seq = Number(head.seq) + 1;
          const entry = {
            id: randomUUID(),
            type: "custom",
            customType: "experiment.pg_repair",
            data: "interrupted text",
            parentId: head.lanes.main,
            seq,
            timestamp: Date.now(),
          };
          const item = { kind: "entry", lane: "main", seq, entry };
          await db.query("insert into entries values($1,$2,$3)", [
            body.sessionId,
            seq,
            JSON.stringify(item),
          ]);
          await db.query("update heads set seq=$2,lanes=$3 where id=$1", [
            body.sessionId,
            seq,
            JSON.stringify({ ...head.lanes, main: entry.id }),
          ]);
          await db.query("commit");
        } catch (error) {
          await db.query("rollback");
          throw error;
        } finally {
          db.release();
        }
      } else if (url.pathname === "/log")
        result = (
          await pool.query<{ item: NativeItem }>(
            "select item from entries where session_id=$1 order by seq",
            [url.searchParams.get("session")],
          )
        ).rows.map((row) => row.item);
      else if (url.pathname === "/cleanup") {
        await stop();
        await admin.deleteTopics({ topics: [topic] });
      } else assert.equal(url.pathname, "/health");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      response
        .writeHead(500, { "content-type": "application/json" })
        .end(
          JSON.stringify({ error: error instanceof Error ? error.message : "experiment error" }),
        );
    }
  });
  server.listen(4000, "0.0.0.0");
}
