import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { CommittedLaneView, PostgresPiSessionStorage } from "@pi-cloud/pi-session-postgres";
import type { PiSessionAppendOperation } from "@pi-cloud/pi-session-postgres";
import { sql } from "kysely";

// Isolated real PostgreSQL, no model, Kafka or production state. Both variants
// still await the same durable PG append; only branch materialization changes.
const image = "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";
const container = `pi-cloud-lane-view-${randomUUID()}`;
const password = randomBytes(24).toString("base64url");
const steps = 12;

function docker(args: string[]) {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => Number((sorted[Math.ceil(sorted.length * p) - 1] ?? 0).toFixed(3));
  return { p50: at(0.5), p95: at(0.95), sum: Number(values.reduce((a, b) => a + b, 0).toFixed(3)) };
}

let started = false;
try {
  docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    container,
    "--cpus",
    "2",
    "--memory",
    "1g",
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    image,
  ]);
  started = true;
  const port = Number(/:([0-9]+)$/u.exec(docker(["port", container, "5432/tcp"]))?.[1]);
  const database = createDatabase({
    connectionString: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,
    maxConnections: 16,
  });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await sql`select 1`.execute(database);
        break;
      } catch (error) {
        if (attempt >= 100) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await runMigrations(database, "up");
    const tenantId = randomUUID();
    await database
      .insertInto("tenants")
      .values({ id: tenantId, slug: "lane-view-ablation" })
      .execute();
    const results = [];
    for (const contextBytes of [64 * 1024, 1024 * 1024, 8 * 1024 * 1024]) {
      const sessions = contextBytes >= 8 * 1024 * 1024 ? 4 : 16;
      // Reverse order on the second pass to expose warm-cache/order effects.
      for (const [pass, modes] of [
        [1, [false, true]],
        [2, [true, false]],
      ] as const) {
        for (const cached of modes) {
          const fixtures = [];
          for (let index = 0; index < sessions; index++) {
            const sessionId = randomUUID();
            const storage = await PostgresPiSessionStorage.create({
              database,
              tenantId,
              sessionId,
            });
            const chunks = contextBytes / (64 * 1024);
            for (let chunk = 0; chunk < chunks; chunk += 16) {
              const items: PiSessionAppendOperation[] = Array.from(
                { length: Math.min(16, chunks - chunk) },
                () => ({
                  kind: "append_entry",
                  lane: "main",
                  entry: {
                    id: randomUUID(),
                    type: "custom",
                    customType: "benchmark",
                    data: "x".repeat(64 * 1024),
                  },
                }),
              );
              await new PostgresPiSessionStorage({
                database,
                tenantId,
                sessionId,
                projectedMutationId: randomUUID(),
              }).appendItems(items);
            }
            fixtures.push(storage);
          }
          const reads: number[] = [],
            writes: number[] = [];
          let storageReads = 0,
            storageBytes = 0,
            memoryReads = 0;
          const startedAt = performance.now();
          await Promise.all(
            fixtures.map(async (storage) => {
              const readBranch = async () =>
                (
                  await storage
                    .asSession()
                    .view("main")
                    .findEntriesOnBranch({ stopAtType: "compaction", order: "newestFirst" })
                ).reverse();
              const view = cached ? new CommittedLaneView({ lane: "main", readBranch }) : undefined;
              const mutate = async (
                entry: Extract<PiSessionAppendOperation, { kind: "append_entry" }>["entry"],
              ) => {
                const operation = { kind: "append_entry" as const, lane: "main", entry };
                if (view)
                  return view
                    .publisher({ mutate: async () => storage.appendEntry(entry, "main") })
                    .mutate(operation);
                return storage.appendEntry(entry, "main");
              };
              for (let step = 0; step < steps; step++) {
                const readAt = performance.now();
                const path = view ? await view.read() : await readBranch();
                reads.push(performance.now() - readAt); // includes memory snapshot cloning
                assert.equal(path.length, contextBytes / (64 * 1024) + step);
                if (!view) {
                  storageReads++;
                  storageBytes += Buffer.byteLength(JSON.stringify(path));
                }
                const writeAt = performance.now();
                await mutate({
                  id: randomUUID(),
                  type: "custom",
                  customType: "benchmark.step",
                  data: { step, text: "y".repeat(512) },
                });
                writes.push(performance.now() - writeAt);
              }
              if (view) {
                const stats = view.statistics();
                storageReads += stats.storageReads;
                storageBytes += stats.storageBytes;
                memoryReads += stats.memoryReads;
              }
              // Validate outside the read histogram, but include it in wall time:
              // no stale metadata, omitted entries or fabricated parent/sequence.
              if (view) assert.deepEqual(await view.read(), await readBranch());
              view?.close();
            }),
          );
          const elapsedMs = performance.now() - startedAt;
          const result = {
            pass,
            mode: cached ? "committed-memory" : "pg-per-step",
            contextBytes,
            sessions,
            steps,
            storageReads,
            memoryReads,
            estimatedStorageJsonBytes: storageBytes,
            readMs: summary(reads),
            durableAppendMs: summary(writes),
            elapsedMs: Number(elapsedMs.toFixed(1)),
            stepsPerSecond: Number(((sessions * steps * 1000) / elapsedMs).toFixed(1)),
          };
          results.push(result);
          console.log(JSON.stringify(result));
        }
      }
    }
    console.log(
      JSON.stringify({
        accepted: true,
        modelRequests: 0,
        postgresCpu: 2,
        postgresMemoryMiB: 1024,
        steps,
        results,
      }),
    );
  } finally {
    await database.destroy();
  }
} finally {
  if (started) docker(["rm", "--force", container]);
}
