import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { WorkerToolRuntime } from "../../src/tools/worker-tool-runtime.ts";
import { withToolInvocation } from "../../../sandbox-supervisor/src/tool-invocation.ts";
import { createExecutionReference } from "../../../protocol/src/execution-reference.ts";

assert.equal(typeof global.gc, "function", "Run node --expose-gc --import tsx");
const refs = [];
const closedCallbacks = [];
let resultBytes = 0,
  callback;
const runId = randomUUID();
const runtime = new WorkerToolRuntime({
  maximumDepth: null,
  nativeConversations: { childAnchor: async () => null, conversationDepth: async () => 0 },
  control: {
    request: async (input) => {
      input.onPublished?.();
      const value = {
        state: "completed",
        executionId: input.toolCallId,
        output: randomBytes(4096).toString("hex"),
      };
      resultBytes += Buffer.byteLength(JSON.stringify(value));
      refs.push(new WeakRef(value));
      return value;
    },
  },
  wait: () => {
    throw new Error("No fixed Tool reply in this cache-lifetime probe");
  },
});
let bindings = await runtime.create({
  command: {
    payload: {
      sessionKind: "conversation",
      tenantId: randomUUID(),
      sessionId: randomUUID(),
      runId,
      executionReference: createExecutionReference(randomUUID(), runId, 1),
      piSession: { conversationId: 1 },
    },
  },
  prepareEnvironment: async () => {
    throw new Error("No VM in this probe");
  },
  prepareWorkflow: async (_id, _script, call) => {
    callback = call;
    closedCallbacks.push(call);
    return {
      command: {},
      completed: () => true,
      dispose() {
        callback = undefined;
      },
      result: async () => ({ content: [] }),
    };
  },
});
let tool = bindings.find((x) => x.tool.name === "subagent").tool;
async function executeAndDispose(index) {
  const callId = `call-${index}`;
  const prepared = await withToolInvocation(
    { id: `task:${index + 1}`, nativeToolCallId: callId },
    () =>
      tool.prepareExecution(callId, {
        action: "workflow",
        script: "return await runs.run('one', {task:'fixture'})",
      }),
  );
  await callback("run", { key: "one", task: { task: "Owned memory fixture" } });
  await prepared.result();
  prepared.dispose();
}
for (let i = 0; i < 64; i++) await executeAndDispose(i);
async function collect() {
  for (let i = 0; i < 5; i++) {
    await nextTurn();
    global.gc();
  }
  return refs.filter((x) => x.deref() !== undefined).length;
}
const retainedWhileRunOpen = await collect();
assert.equal(retainedWhileRunOpen, 0);
assert.equal(closedCallbacks.length, 64);
tool = undefined;
bindings = undefined;
const retainedAfterBindingRelease = await collect();
assert.equal(retainedAfterBindingRelease, 0);
console.log(
  JSON.stringify({
    case: "completed_workflow_result_retention",
    completedAndDisposedTools: 64,
    resultBytes,
    retainedWhileRunOpen,
    retainedClosedCallbacks: closedCallbacks.length,
    retainedAfterBindingRelease,
    proof: "WeakRef reachability with explicit GC; not a production heap capacity estimate",
    modelCalls: 0,
    vmEffects: 0,
  }),
);
