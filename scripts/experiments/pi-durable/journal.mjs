// Experimental Storage adapter. Production never imports this package.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { Admin } from "@platformatic/kafka";
import { MemoryStorage, StorageRejected } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { KafkaLogConsumer } from "../../../packages/event-log/src/index.ts";
import { ExecutionLogTopic } from "../../../packages/runtime-core/src/execution-log-topic.ts";
import { SessionPublicationIngress } from "../../../packages/runtime-core/src/session-publication-ingress.ts";
import { PublicationNotSentError } from "../../../packages/protocol/src/native-session.ts";

export async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(10);
  }
  throw new Error(`Probe timed out: ${label}`);
}
export const deferred = () => Promise.withResolvers();
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
export const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

/** The upstream prepare/apply split preserves ACK-before-visibility. */
export class JournalStorage extends MemoryStorage {
  constructor(publish, options = {}) {
    super();
    this.publish = publish;
    this.options = options;
    this.commits = [];
    this.failed = false;
  }
  async commit(writes, context) {
    if (this.failed) throw new Error("Probe writer is retired after uncertain publication");
    const prepared = this.prepareCommit(writes);
    const batch = { seq: prepared.seq, writes: prepared.writes };
    await this.options.before?.(batch);
    try {
      await this.publish(batch, this.options.commands?.(batch) ?? []);
      await this.options.afterPublication?.(batch);
    } catch (error) {
      if (error instanceof PublicationNotSentError)
        throw new StorageRejected(error.message, { cause: error });
      this.failed = true;
      throw error;
    }
    assert.equal(prepared.apply(), batch.seq);
    this.commits.push(batch);
    this.options.applied?.(batch);
    return batch.seq;
  }
  restore(batches) {
    for (const batch of batches) this.prepareCommit(batch.writes, batch.seq).apply();
  }
}

/** Private RF3 topic + exact PG batch projection. Small-fixture cold replay only.
 * The private envelope is deliberately not a production AcceptedFact schema.
 * Reuse current ingress/transactional writer under fixture grants, as other
 * transport checks do. No production Projector or PG authority is bypassed. */
export async function openJournalBackend({ brokers, databaseUrl }) {
  const id = randomUUID();
  const topic = `pi-cloud.durable-probe.${id}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  pool.on("error", () => {});
  await pool.query(`create table if not exists durable_probe_batches (
    session_id uuid not null, seq bigint not null, digest text not null,
    batch jsonb not null, primary key(session_id,seq))`);
  const log = new ExecutionLogTopic({
    brokers,
    topic,
    clientId: topic,
    partitions: 1,
    replicas: 3,
  });
  const ingress = new SessionPublicationIngress();
  const admitted = new Set();
  let retiring = Promise.resolve();
  const scopes = new Map();
  const hooks = new Map();
  const observed = [];
  let projectionGate;
  let failure;
  const project = async (fact) => {
    const { batch, scope } = fact;
    const result = await pool.query(
      `insert into durable_probe_batches values($1,$2,$3,$4) on conflict do nothing returning seq`,
      [scope.piSessionId, batch.seq, digest(batch), JSON.stringify(batch)],
    );
    const row = (
      await pool.query("select digest from durable_probe_batches where session_id=$1 and seq=$2", [
        scope.piSessionId,
        batch.seq,
      ])
    ).rows[0];
    assert.equal(row.digest, digest(batch), "Same commit position changed bytes");
    return result.rowCount === 1;
  };
  const consumer = new KafkaLogConsumer({
    brokers,
    topic,
    clientId: `${topic}-projection`,
    groupId: `${topic}-projection`,
    groupRecovery: true,
    orderedEffects: true,
    decode: (bytes) => JSON.parse(bytes.toString()),
    replayOffsets: async (bounds) => new Map(bounds.map((b) => [b.partition, b.low])),
    onRevoked: () => {
      admitted.clear();
      retiring = ingress.revoke(0);
    },
    onAssigned: async (partitions, current) => {
      await retiring;
      for (const partition of partitions) {
        const writer = await consumer.openPublicationWriter(partition, current);
        if (current()) ingress.installPartition(partition, writer);
        else await writer.close();
      }
    },
    handler: async ({ fact, ...position }, current, commitBeforeEffect) => {
      try {
        if (fact.kind !== "pi_durable_probe_commit_v1") return;
        await projectionGate?.promise;
        const first = await project(fact);
        observed.push({
          sessionId: fact.scope.piSessionId,
          seq: fact.batch.seq,
          bytes: Buffer.byteLength(JSON.stringify(fact.batch)),
        });
        if (first && fact.commands?.length && current() && (await commitBeforeEffect()))
          for (const command of fact.commands)
            await hooks.get(fact.scope.piSessionId)?.(command, position);
      } catch (error) {
        failure = error;
        throw error;
      }
    },
  });
  try {
    await log.start();
    await consumer.start();
    await consumer.waitUntilAssigned(20000);
  } catch (error) {
    for (const close of [
      () => ingress.close(),
      () => consumer.close(),
      () => log.close(),
      () => pool.end(),
    ])
      try {
        await close();
      } catch {
        /* Keep the original startup error. */
      }
    throw error;
  }
  const scopeFor = (sessionId) => {
    if (!scopes.has(sessionId))
      scopes.set(sessionId, {
        tenantId: randomUUID(),
        sessionId,
        piSessionId: sessionId,
        runId: randomUUID(),
        turnId: randomUUID(),
        writerId: randomUUID(),
        fencingToken: 1,
      });
    return scopes.get(sessionId);
  };
  return {
    topic,
    observed,
    pool,
    setDispatcher(sessionId, fn) {
      hooks.set(sessionId, fn);
    },
    pauseProjection() {
      assert(!projectionGate);
      projectionGate = deferred();
    },
    resumeProjection() {
      projectionGate?.resolve();
      projectionGate = undefined;
    },
    async publish(sessionId, batch, commands = []) {
      if (failure) throw failure;
      const scope = scopeFor(sessionId),
        owner = ingress.ownership(0);
      assert(owner, "Probe partition owner missing");
      if (!admitted.has(scope.runId)) {
        ingress.installRun(owner, {
          scope: { ...scope, leaseId: scope.writerId, piSessionLane: "main" },
        });
        admitted.add(scope.runId);
      }
      await ingress.append(owner, {
        kind: "pi_durable_probe_commit_v1",
        factId: randomUUID(),
        scope,
        occurredAt: new Date().toISOString(),
        batch,
        commands,
      });
    },
    async rows(sessionId) {
      return (
        await pool.query(
          "select batch from durable_probe_batches where session_id=$1 order by seq",
          [sessionId],
        )
      ).rows.map((r) => r.batch);
    },
    async waitProjected(sessionId, seq) {
      return until(async () => {
        if (failure) throw failure;
        const r = await pool.query(
          "select max(seq)::bigint as seq from durable_probe_batches where session_id=$1",
          [sessionId],
        );
        return Number(r.rows[0].seq ?? 0) >= seq;
      }, "projection boundary");
    },
    async open(sessionId = randomUUID(), options = {}) {
      const store = new JournalStorage(
        (batch, commands) => this.publish(sessionId, batch, commands),
        options,
      );
      const batches = await this.rows(sessionId);
      store.restore(batches);
      return { store, sessionId, restoredBatches: batches.length };
    },
    async duplicate(sessionId, batch) {
      return project({ scope: scopeFor(sessionId), batch });
    },
    async closeFixtureWriter(sessionId) {
      const owner = ingress.ownership(0);
      assert(owner);
      await ingress.seal(owner, {
        kind: "execution_seal",
        factId: randomUUID(),
        scope: scopeFor(sessionId),
        closesWriter: true,
        occurredAt: new Date().toISOString(),
      });
    },
    async close() {
      this.resumeProjection();
      await ingress.close();
      await consumer.close();
      await log.close();
      const admin = new Admin({ bootstrapBrokers: brokers, clientId: `${topic}-cleanup` });
      try {
        await admin.deleteTopics({ topics: [topic] });
      } finally {
        await admin.close();
      }
      await pool.query("delete from durable_probe_batches where session_id=any($1::uuid[])", [
        [...scopes.keys()],
      ]);
      await pool.end();
    },
  };
}

export async function viewEntries(harness, id) {
  return harness
    .commit((tx) => tx.scanEntries({ conversationId: id }, 1000), BACKGROUND_CONTEXT)
    .then((p) => p.items);
}
