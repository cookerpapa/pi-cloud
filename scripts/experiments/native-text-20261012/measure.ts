import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  createPiCloudEventFactory,
  resolveDurableText,
  type DurableSessionCommit,
} from "@pi-cloud/protocol";
import type { NativeDocumentChange } from "@pi-cloud/pi-session-postgres/durable";
import { DurableTextPresentation } from "../../../packages/sandbox-supervisor/src/durable/text-presentation.ts";

// Isolated wire-size comparison, not a production throughput benchmark. Common
// Tool/control traffic and Kafka compression are excluded from both sides.
const scope = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  sessionId: "10000000-0000-4000-8000-000000000002",
  piSessionId: "10000000-0000-4000-8000-000000000002",
  runId: "10000000-0000-4000-8000-000000000003",
  turnId: "10000000-0000-4000-8000-000000000004",
  writerId: "10000000-0000-4000-8000-000000000005",
  fencingToken: 1,
};
const text = new DurableTextPresentation({ conversationId: 1 });
const factory = createPiCloudEventFactory(
  { sessionId: scope.sessionId, turnId: scope.turnId, agentId: "root" },
  { clock: () => new Date(0), idGenerator: () => "10000000-0000-4000-8000-000000000006" },
);
const record = {
  id: 2,
  kind: "pi.live",
  scope: { kind: "conversation", conversationId: 1 },
  history: "latest",
  fork: "initial",
  createdAt: 1,
};
const doc = (content: string) => ({
  record,
  version: 1,
  deltasSinceBase: 0,
  value: {
    run: { taskId: 3, inputs: [] },
    generation: {
      attempt: 1,
      message: fauxAssistantMessage(content, { timestamp: 1, stopReason: "pending" }),
    },
  },
});
const old: unknown[] = [],
  next: unknown[] = [];
let body = "",
  before = doc("");
for (let n = 1; n <= 101; n++) {
  const chunk = "阿🌍code ".repeat(128);
  if (n <= 100) body += chunk;
  const after = n === 101 ? { ...before, value: {} } : doc(body);
  const writes =
    n === 101
      ? [
          {
            type: "entry",
            value: {
              id: 4,
              conversationId: 1,
              byTaskId: 3,
              kind: "pi.assistant",
              model: [fauxAssistantMessage(body, { timestamp: 1 })],
            },
          },
          { type: "document.change", id: 2, content: { kind: "base", version: 1, value: {} } },
        ]
      : [
          {
            type: "document.change",
            id: 2,
            content:
              n === 1
                ? { kind: "base", version: 1, value: after.value }
                : {
                    kind: "delta",
                    version: 1,
                    ops: [["a", ["generation", "message", "content", 0, "text"], chunk]],
                  },
          },
        ];
  const commit: DurableSessionCommit = { seq: n, nextId: 5, writes };
  const fingerprint = createHash("sha256").update(JSON.stringify(commit)).digest("hex");
  const prepared = text.prepare(
    commit,
    [{ record, before, after }] as unknown as NativeDocumentChange[],
    factory,
  );
  const base = {
    kind: "durable_commit",
    factId: "10000000-0000-4000-8000-000000000007",
    scope,
    commit,
    origins: [],
    tools: [],
    cancellations: [],
    occurredAt: new Date(0).toISOString(),
  };
  old.push({ ...base, events: [] });
  for (const description of prepared.texts)
    if (n <= 100) {
      const event = resolveDurableText(commit, description, () => after.value);
      old.push({
        kind: "agent_event",
        factId: event.eventId,
        scope,
        event,
        occurredAt: event.occurredAt,
      });
    }
  next.push({
    ...base,
    display: [
      {
        scope,
        texts: prepared.texts,
        ...(prepared.coveredThrough === undefined
          ? {}
          : { coveredThrough: prepared.coveredThrough }),
      },
    ],
  });
  prepared.confirmed();
  assert.equal(createHash("sha256").update(JSON.stringify(commit)).digest("hex"), fingerprint);
  before = doc(body);
}
const bytes = (records: unknown[]) =>
  records.reduce<number>((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0);
console.log(
  JSON.stringify(
    {
      workload: "100 UTF-8 text chunks plus final Assistant Entry; identical native batches",
      textBytes: Buffer.byteLength(body),
      before: { records: old.length, bytes: bytes(old) },
      after: { records: next.length, bytes: bytes(next) },
      reduction: {
        records: old.length - next.length,
        bytes: bytes(old) - bytes(next),
        percent: +((1 - bytes(next) / bytes(old)) * 100).toFixed(2),
      },
    },
    null,
    2,
  ),
);
