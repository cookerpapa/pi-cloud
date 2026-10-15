import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { nativeSubagentFixture } from "../../../packages/control-plane/test/native-subagent-fixture.ts";
import { PostgresSubagentConversations } from "../../../packages/subagent-control/src/postgres-subagent-conversations.ts";
import { ExecutionStreamProjector } from "../../../packages/runtime-core/src/execution-stream-projection.ts";
import { SessionLiveView } from "../../../packages/runtime-core/src/session-live-view.ts";
import { CompactEventTail } from "../../../packages/runtime-core/src/compact-event-tail.ts";
import { requestExecutionStreamSeal } from "../../../packages/runtime-core/src/execution-stream-seal.ts";

if (process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)
  throw new Error("This review probe requires isolated PGlite");
const f = await nativeSubagentFixture();
const live = new SessionLiveView(async () => {});
const originalSet = Map.prototype.set;
let prefixes: Map<string, CompactEventTail> | undefined;
try {
  const call = await f.command({ task: "Synthetic child for projector review" });
  const jobs = new PostgresSubagentConversations({ database: f.database, native: f.native });
  const child = await jobs.start({
    id: call.operationId,
    tenantId: f.scope.tenantId,
    rootRunId: f.scope.runId,
    parentSessionId: f.scope.sessionId,
    parentTurnId: f.scope.turnId,
    executionReference: f.reference,
    parentToolCallId: `task:${call.taskId}`,
    source: { sequence: call.nativeSequence, taskId: call.taskId },
    prompt: String(call.arguments.task),
    contextMode: "fresh",
    contextAnchor: null,
    sandboxMode: "shared",
  });
  const childScope = { ...f.scope, sessionId: child.childSessionId, turnId: child.childTurnId };
  const conversationId = f.children.get(call.operationId)!.conversationId;
  const projector = new ExecutionStreamProjector(f.database);
  Map.prototype.set = function (key: any, value: any) {
    if (
      value instanceof CompactEventTail &&
      typeof key === "string" &&
      key.startsWith(`${f.scope.writerId}:`)
    )
      prefixes = this as Map<string, CompactEventTail>;
    return originalSet.call(this, key, value);
  } as typeof originalSet;
  const head = await f.projection.head();
  const docId = 10000,
    part = "x".repeat(131072);
  await projector.project({
    fact: {
      kind: "durable_commit",
      factId: randomUUID(),
      scope: f.scope,
      commit: {
        seq: head.seq + 1,
        nextId: docId + 1,
        writes: [
          {
            type: "document.create",
            record: {
              id: docId,
              kind: "pi.live",
              scope: { kind: "conversation", conversationId },
              history: "latest",
              fork: "initial",
            },
            content: { kind: "base", version: 1, value: {} },
          },
        ],
      },
      origins: [],
      tools: [],
      cancellations: [],
      display: [],
      occurredAt: new Date().toISOString(),
    },
    topic: "review-prefix",
    partition: 0,
    offset: 10n,
  });
  for (let i = 0; i < 2; i++) {
    const text = part.repeat(i + 1);
    const write = {
      type: "document.change",
      id: docId,
      content: {
        kind: "delta",
        version: 1,
        ops:
          i === 0
            ? [["s", ["generation"], { attempt: 1, message: { text } }]]
            : [["s", ["generation", "message", "text"], text]],
      },
    };
    const event = {
      schemaVersion: 1,
      eventId: randomUUID(),
      sessionId: childScope.sessionId,
      turnId: childScope.turnId,
      agentId: "child",
      seq: i + 1,
      occurredAt: new Date().toISOString(),
      type: "assistant.text.delta",
      payload: { messageId: "review-live", phase: "final_answer" },
    };
    const fact: any = {
      kind: "durable_commit",
      factId: randomUUID(),
      scope: f.scope,
      commit: { seq: head.seq + i + 2, nextId: docId + 1, writes: [write] },
      origins: [],
      tools: [],
      cancellations: [],
      display: [
        {
          scope: childScope,
          texts: [
            {
              event,
              source: {
                kind: "document",
                id: docId,
                path: ["generation", "message", "text"],
                start: i * part.length,
                end: text.length,
              },
            },
          ],
        },
      ],
      occurredAt: event.occurredAt,
    };
    const result = await projector.project({
      fact,
      topic: "review-prefix",
      partition: 0,
      offset: BigInt(11 + i),
    });
    for (const e of result?.events ?? []) live.accept(f.scope.tenantId, e);
  }
  assert(prefixes);
  const before = {
    tails: prefixes.size,
    logicalTextBytes: [...prefixes.values()].reduce((n, t) => n + Buffer.byteLength(t.text()), 0),
    publicLiveViewTextBytes: Buffer.byteLength(
      live
        .snapshot(f.scope.tenantId, childScope.sessionId)
        .events.map((e) => (e.payload as any).text ?? "")
        .join(""),
    ),
  };
  const sealId = randomUUID();
  await f.database.transaction().execute((tx) =>
    requestExecutionStreamSeal(tx, {
      ...f.scope,
      agentId: "root",
      now: new Date(),
      eventId: sealId,
      recover: true,
    }),
  );
  const row = await f.database
    .selectFrom("outbox")
    .select("payload")
    .where("id", "=", sealId)
    .executeTakeFirstOrThrow();
  await projector.project({
    fact: row.payload as any,
    topic: "review-prefix",
    partition: 0,
    offset: 20n,
  });
  const writer = await f.database
    .selectFrom("session_leases")
    .select(["writer_seal_offset", "released_at"])
    .where("lease_id", "=", f.scope.writerId)
    .executeTakeFirstOrThrow();
  const after = {
    tails: prefixes.size,
    logicalTextBytes: [...prefixes.values()].reduce((n, t) => n + Buffer.byteLength(t.text()), 0),
    oldWriterSealOffset: writer.writer_seal_offset,
    oldWriterReleased: writer.released_at !== null,
    childTailRetained: [...prefixes.keys()].some((k) => k.endsWith(childScope.sessionId)),
  };
  assert.equal(before.logicalTextBytes, 262144);
  assert.equal(before.publicLiveViewTextBytes, 262144);
  assert.equal(after.oldWriterSealOffset, "20");
  assert.equal(after.childTailRetained, true);
  projector.reset();
  const output = {
    baseline: "c3aca045",
    kind: "isolated-PGlite-real-projection-characterization",
    note: "No runtime source changes. A temporary Map.set observation captures the actual private prefix map. Byte counts are logical retained text, not measured RSS.",
    before,
    after,
    afterReset: { tails: prefixes.size },
  };
  await writeFile(
    "/tmp/pi-cloud-projector-prefix-review-20261015.json",
    JSON.stringify(output, null, 2) + "\n",
  );
  console.log(JSON.stringify(output, null, 2));
} finally {
  Map.prototype.set = originalSet;
  live.close();
  await f.close();
}
