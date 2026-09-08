import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { KafkaAckSessionStorage, type NativeFact, type NativeItem } from "./storage.ts";
import { runPaidCoding } from "./paid-coding.ts";

if (process.env.PI_CLOUD_KAFKA_SESSION_EXPERIMENT !== "1")
  throw new Error("Set PI_CLOUD_KAFKA_SESSION_EXPERIMENT=1 for private Kafka/PostgreSQL resources");
const exec = promisify(execFile);
const id = randomUUID();
const pgName = `pi-cloud-append-pg-${id}`,
  serverName = `pi-cloud-append-sink-${id}`;
const topic = `pi-cloud.native-append-experiment.${id}`;
const password = randomBytes(24).toString("hex"),
  token = randomBytes(24).toString("hex");
const pgImage = "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";
const nodeImage =
  "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
const docker = async (...args: string[]) =>
  (
    await exec("docker", args, { timeout: 120000, maxBuffer: 2 * 1024 * 1024 }).catch((error) => {
      throw new Error(
        String(error.stderr || "Docker fixture command failed")
          .replaceAll(password, "[redacted]")
          .replaceAll(token, "[redacted]"),
      );
    })
  ).stdout.trim();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let base = "";
const request = async <T = any>(path: string, data?: unknown): Promise<T> => {
  const response = await fetch(base + path, {
    method: data === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
};
const publish = async (fact: NativeFact, mode = "fast") => {
  await request(
    `/facts${mode === "pg" ? "?wait_pg=1" : mode === "drop" ? "?drop_ack=1" : ""}`,
    fact,
  );
};
const metadata = () => ({ id: randomUUID(), createdAt: Date.now() });
const entry = (text: string) => ({
  id: randomUUID(),
  type: "custom" as const,
  customType: "experiment",
  data: text,
});
const wait = async (predicate: (state: any) => boolean) => {
  const deadline = Date.now() + 60000;
  while (true) {
    const state = await request("/state");
    if (predicate(state)) return state;
    if (Date.now() > deadline)
      throw new Error(`Projection did not catch up: ${state.childDiagnostic}`);
    await delay(20);
  }
};
const normalized = (items: NativeItem[]) =>
  items.map((item) => {
    if (item.kind !== "entry") return item;
    const { lane, ...native } = item;
    return native;
  });
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number((sorted[Math.ceil(sorted.length * p) - 1] ?? 0).toFixed(3));
};
const report: Record<string, unknown> = {
  checkedAt: new Date().toISOString(),
  productionCutover: false,
  accepted: false,
  ablation: [],
};
let pgStarted = false,
  serverStarted = false;
try {
  await docker(
    "run",
    "--detach",
    "--rm",
    "--name",
    pgName,
    "--network",
    "pi-cloud-production_event-log",
    "--cpus",
    "2",
    "--memory",
    "1g",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    pgImage,
  );
  pgStarted = true;
  for (let retry = 0; ; retry++) {
    try {
      await docker("exec", pgName, "pg_isready", "-U", "postgres");
      break;
    } catch (error) {
      if (retry > 50) throw error;
      await delay(100);
    }
  }
  await docker(
    "create",
    "--name",
    serverName,
    "--network",
    "bridge",
    "--cpus",
    "2",
    "--memory",
    "1g",
    "--publish",
    "127.0.0.1::4000",
    "--mount",
    `type=bind,src=${process.cwd()},dst=/app,readonly`,
    "--workdir",
    "/app",
    "-e",
    `EXPERIMENT_TOKEN=${token}`,
    "-e",
    `EXPERIMENT_TOPIC=${topic}`,
    "-e",
    `EXPERIMENT_DATABASE_URL=postgresql://postgres:${password}@${pgName}:5432/postgres`,
    nodeImage,
    "node",
    "--import",
    "tsx",
    "experiments/kafka-session-append/server.ts",
  );
  serverStarted = true;
  await docker("network", "connect", "pi-cloud-production_event-log", serverName);
  await docker("start", serverName);
  const port = /:(\d+)$/u.exec(await docker("port", serverName, "4000/tcp"))![1];
  base = `http://127.0.0.1:${port}`;
  for (let retry = 0; ; retry++) {
    try {
      await request("/health");
      break;
    } catch (error) {
      if (retry > 100) throw error;
      await delay(100);
    }
  }

  const meta = metadata(),
    facts: NativeFact[] = [];
  const writer = new KafkaAckSessionStorage(meta, "a", async (fact) => {
    facts.push(fact);
    await publish(fact);
  });
  await writer.appendEntry(
    {
      id: "root",
      type: "message",
      message: { role: "user", content: "Keep marker ALPHA", timestamp: 1 },
    },
    "main",
  );
  await writer.createLane("child", "root");
  await writer.createLane("fresh", null);
  await Promise.all(
    ["main", "child", "fresh"].map(async (lane) => {
      for (let step = 0; step < 12; step++)
        await writer.appendEntry(entry(`${lane}-${step}`), lane);
    }),
  );
  await writer.seal();
  assert.equal(
    (await request("/state")).heads.length,
    0,
    "PG projected while its process was stopped",
  );
  report.stoppedProjector = {
    acknowledgedFacts: facts.length,
    nativeItems: (await writer.getLog()).length,
    projectedItems: 0,
  };
  await request("/projector/start", { delayMs: 0 });
  await wait((state) => state.seals.some((s: any) => s.session_id === meta.id));
  const firstLog = await request<NativeItem[]>(`/log?session=${meta.id}`);
  assert.deepEqual(normalized(firstLog), await writer.getLog());

  // Real SIGKILL, then a replacement consumer starts from its PG offset.
  await request("/projector/kill", {});
  const replacement = await KafkaAckSessionStorage.restore(meta, "b", (f) => publish(f), firstLog);
  await replacement.appendEntry(entry("replacement continues from exact stamps"), "main");
  await replacement.seal();
  const late: NativeFact = {
    kind: "append",
    id: randomUUID(),
    sessionId: meta.id,
    writerId: "a",
    items: [
      {
        kind: "entry",
        lane: "main",
        seq: firstLog.length + 1,
        entry: {
          ...entry("old delayed write"),
          parentId: null,
          seq: firstLog.length + 1,
          timestamp: 1,
        },
      },
    ],
  };
  await publish(late);
  await publish(facts[0]!); // native application-level duplicate across reconnect
  await request("/projector/start", { delayMs: 0 });
  await wait((state) => state.receipts.some((r: any) => r.id === late.id));
  assert.deepEqual(
    normalized(await request<NativeItem[]>(`/log?session=${meta.id}`)),
    await replacement.getLog(),
  );
  assert.equal(
    (await request("/state")).receipts.find((r: any) => r.id === late.id).status,
    "excluded",
  );
  report.recovery = {
    sigkillRestart: true,
    restoredExactMetadata: true,
    duplicateNotReapplied: true,
    postSealOldWriteExcluded: true,
  };

  const uncertainMeta = metadata();
  let uncertainFact!: NativeFact;
  const uncertain = new KafkaAckSessionStorage(uncertainMeta, "uncertain", async (f) => {
    uncertainFact = f;
    await publish(f, "drop");
  });
  await assert.rejects(uncertain.appendEntry(entry("durable but unacknowledged"), "main"));
  await assert.rejects(
    uncertain.appendEntry(entry("must not reuse sequence"), "main"),
    /requires recovery/,
  );
  await wait((state) => state.receipts.some((r: any) => r.id === uncertainFact.id));
  assert.equal((await request<NativeItem[]>(`/log?session=${uncertainMeta.id}`)).length, 1);
  report.lostAck = { actuallyPersisted: true, staleWriterStopped: true };

  for (const projectionDelayMs of [0, 25]) {
    await request("/projector/kill", {});
    await request("/projector/start", { delayMs: projectionDelayMs });
    for (const sessions of [1, 16]) {
      for (const mode of ["pg", "fast"]) {
        const latencies: number[] = [],
          endings: string[] = [];
        const started = performance.now();
        await Promise.all(
          Array.from({ length: sessions }, async () => {
            const actor = new KafkaAckSessionStorage(metadata(), randomUUID(), async (fact) => {
              const start = performance.now();
              await publish(fact, mode);
              latencies.push(performance.now() - start);
              if (fact.kind === "seal") endings.push(fact.id);
            });
            for (let step = 0; step < 20; step++)
              await actor.appendEntry(entry("x".repeat(1024)), "main");
            await actor.seal();
          }),
        );
        const elapsedMs = performance.now() - started;
        const result = {
          projectionDelayMs,
          sessions,
          mode,
          appends: latencies.length,
          p50Ms: percentile(latencies, 0.5),
          p95Ms: percentile(latencies, 0.95),
          acknowledgementsPerSecond: Number(((latencies.length * 1000) / elapsedMs).toFixed(1)),
          elapsedMs: Math.round(elapsedMs),
        };
        (report.ablation as unknown[]).push(result);
        console.log(JSON.stringify(result));
        // Drain outside the measured writer path before the next comparison.
        await wait((state) => endings.every((id) => state.receipts.some((r: any) => r.id === id)));
      }
    }
  }
  if (process.env.PI_CLOUD_KAFKA_SESSION_PAID_CHECK === "1") {
    await request("/projector/kill", {});
    report.paidCoding = await runPaidCoding(async (meta, run) => {
      const actor = new KafkaAckSessionStorage(meta, randomUUID(), (f) => publish(f));
      const result = await run(actor);
      await actor.seal();
      assert(!(await request("/state")).heads.some((h: any) => h.id === meta.id));
      await request("/projector/start", { delayMs: 0 });
      await wait((state) => state.seals.some((s: any) => s.session_id === meta.id));
      assert.deepEqual(
        normalized(await request<NativeItem[]>(`/log?session=${meta.id}`)),
        await actor.getLog(),
      );
      return result;
    });
  }
  const conflictMeta = metadata();
  let conflictFact!: NativeFact;
  const conflicting = new KafkaAckSessionStorage(conflictMeta, randomUUID(), async (fact) => {
    conflictFact = fact;
    await publish(fact);
  });
  await conflicting.appendEntry(entry("root"), "main");
  await wait((state) => state.receipts.some((r: any) => r.id === conflictFact.id));
  await request("/external-pg-repair", { sessionId: conflictMeta.id });
  await conflicting.appendEntry(entry("next loop step"), "main");
  const conflict = await wait((state) =>
    state.childDiagnostic.includes("non-consecutive canonical sequence"),
  );
  assert(!conflict.receipts.some((r: any) => r.id === conflictFact.id));
  report.rolloutCounterexample = {
    kafkaAcknowledged: true,
    projectionBlockedByExternalPgWriter: true,
    requiresOneOrderingContractForAllWriters: true,
  };
  report.accepted = true;
  report.transport =
    "private R=3 topic, min.insync.replicas=2, acks=all; 2 CPU/1 GiB sink + 2 CPU/1 GiB PG";
} catch (error) {
  if (serverStarted)
    console.error(
      (await docker("logs", serverName))
        .replaceAll(password, "[redacted]")
        .replaceAll(token, "[redacted]")
        .slice(-2000),
    );
  throw error;
} finally {
  if (serverStarted) {
    try {
      await request("/cleanup", {});
    } catch {
      console.error("Experiment topic cleanup needs inspection:", topic);
    }
    await docker("rm", "--force", serverName);
  }
  if (pgStarted) await docker("rm", "--force", "--volumes", pgName);
  console.log(JSON.stringify({ ...report, containersRemoved: true }));
}
