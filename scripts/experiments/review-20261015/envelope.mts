import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { toolInvocationFixture } from "../../../packages/runtime-core/test/tool-invocation-fixture.ts";
import { parseAcceptedFact } from "../../../packages/runtime-core/src/kafka-accepted-fact.ts";
import { assertSessionPublication } from "../../../packages/runtime-core/src/direct-session-kafka.ts";
import { toolCommandsForFact } from "../../../packages/runtime-core/src/tool-invocation-fact.ts";

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
function fixture(count: number, contentBytes = 0) {
  const { scope, fact } = toolInvocationFixture();
  const baseWrite = fact.commit.writes[0] as any;
  const baseTool = fact.tools[0]!;
  (fact.commit as any).writes = Array.from({ length: count }, (_, i) => ({
    type: "task",
    value: {
      ...structuredClone(baseWrite.value),
      id: 4 + i,
      input: { assistant: 2, callId: `provider-${i}` },
      state: {
        status: "running",
        checkpoint: {
          phase: "execute",
          replay: "unsafe",
          arguments: contentBytes
            ? { path: "large.txt", content: "x".repeat(contentBytes) }
            : { command: "npm test" },
        },
      },
    },
  }));
  (fact.commit as any).nextId = 4 + count;
  fact.tools = Array.from({ length: count }, (_, i) => {
    const operationId = randomUUID();
    return {
      ...structuredClone(baseTool),
      taskId: 4 + i,
      toolCallId: `task:${4 + i}`,
      factId: operationId,
      request: {
        ...structuredClone(baseTool.request),
        operationId,
        toolName: contentBytes ? "write" : "bash",
      },
    };
  }) as any;
  (fact as any).origins = Array.from({ length: count }, (_, i) => ({
    ...fact.origins[0],
    recordId: 4 + i,
  }));
  return { scope, fact };
}
function proposedEnvelope(fact: any) {
  const copy = structuredClone(fact);
  copy.replyTopic = copy.tools[0].replyTopic;
  copy.tools = copy.tools.map((tool: any) => {
    const { scope, toolCallId, factId, replyTopic, nativeToolName, ...rest } = tool;
    return { ...rest, view: { sessionId: scope.sessionId, turnId: scope.turnId } };
  });
  return copy;
}
const sizeSamples = [
  [1, 0],
  [10, 0],
  [100, 0],
  [1, 360000],
].map(([count, contentBytes]) => {
  const { scope, fact } = fixture(count, contentBytes);
  assertSessionPublication({ scope }, fact);
  const before = bytes(fact),
    after = bytes(proposedEnvelope(fact));
  return {
    tools: count,
    argumentContentBytes: contentBytes,
    beforeBytes: before,
    proposedBytes: after,
    savedBytes: before - after,
    savedPercent: ((before - after) * 100) / before,
  };
});
function lookups(count: number, stage: "worker" | "projector") {
  const { scope, fact } = fixture(count);
  let calls = 0,
    comparisons = 0;
  Object.defineProperty(fact.commit.writes, "find", {
    value: function (predicate: any) {
      calls++;
      return Array.prototype.find.call(this, (value: any, index: number, list: any[]) => {
        comparisons++;
        return predicate(value, index, list);
      });
    },
  });
  if (stage === "worker") assertSessionPublication({ scope }, fact);
  else toolCommandsForFact(parseAcceptedFact(fact));
  return { stage, tools: count, linearFinds: calls, elementComparisons: comparisons };
}
const divergence = [];
for (const field of ["factId", "toolCallId", "leaseId", "fencingToken"]) {
  const { scope, fact } = fixture(1);
  const tool = fact.tools[0]! as any;
  if (field === "leaseId") tool.scope.leaseId = randomUUID();
  else if (field === "fencingToken") tool.scope.fencingToken++;
  else tool[field] = field === "toolCallId" ? "task:9999" : randomUUID();
  let publicationAccepted = true;
  try {
    assertSessionPublication({ scope }, fact);
  } catch {
    publicationAccepted = false;
  }
  let parserAccepted = true;
  try {
    parseAcceptedFact(fact);
  } catch {
    parserAccepted = false;
  }
  divergence.push({ field, publicationAccepted, parserAccepted });
}
const output = {
  baseline: "c3aca045",
  kind: "synthetic-source-characterization",
  note: "Proposed serialization is a sizing sketch, not an implemented or deployable protocol. Native batch and origins are unchanged.",
  sizeSamples,
  lookups: [1, 10, 100].flatMap((n) => [lookups(n, "worker"), lookups(n, "projector")]),
  divergence,
};
assert.equal(divergence.find((v) => v.field === "leaseId")!.publicationAccepted, true);
assert.equal(divergence.find((v) => v.field === "fencingToken")!.publicationAccepted, false);
await writeFile(
  "/tmp/pi-cloud-projector-envelope-review-20261015.json",
  JSON.stringify(output, null, 2) + "\n",
);
console.log(JSON.stringify(output, null, 2));
