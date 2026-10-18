// Baseline characterizations for the review, not desired-behavior regressions.
// No model, database, production service or credentials are used.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { setImmediate as tick } from "node:timers/promises";
import type { ServerResponse } from "node:http";
import { parsePiCloudEvent, MAX_EXECUTION_FACT_BYTES } from "@pi-cloud/protocol";
import type { ConversationDetailResource, PiCloudEvent, RunObservation } from "@pi-cloud/protocol";
import { SessionLiveView } from "../../../packages/runtime-core/src/session-live-view.ts";
import { SessionEventStream } from "../../../packages/runtime-core/src/session-event-stream.ts";
import { SessionEventHub } from "../../../packages/runtime-core/src/session-event-hub.ts";
import { RunObservations } from "../../../packages/runtime-core/src/run-observations.ts";
import { RunObservationView } from "../../../packages/runtime-core/src/run-observation-view.ts";
import { CompactEventTail } from "../../../packages/runtime-core/src/compact-event-tail.ts";
import { projectConversationTurnTranscript } from "../../../packages/runtime-core/src/conversation-turn-projection.ts";
import type { KafkaAcceptedFactRecord } from "../../../packages/runtime-core/src/kafka-accepted-fact-consumer.ts";
import { RunObservationStore } from "../../../packages/web-ui/src/RunStatus.tsx";
import { SseFrameParser } from "../../../packages/web-ui/src/sse.ts";

const scope = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  sessionId: "10000000-0000-4000-8000-000000000002",
  turnId: "10000000-0000-4000-8000-000000000003",
  runId: "10000000-0000-4000-8000-000000000004",
  writerId: "10000000-0000-4000-8000-000000000005",
  piSessionId: "10000000-0000-4000-8000-000000000006",
  fencingToken: 1,
};
const nextScope = { ...scope, writerId: "10000000-0000-4000-8000-000000000007", fencingToken: 2 };
const event = (
  seq: number,
  text: string,
  phase: "commentary" | "final_answer" = "final_answer",
): PiCloudEvent => ({
  schemaVersion: 1,
  eventId: `20000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  sessionId: scope.sessionId,
  turnId: scope.turnId,
  agentId: "root",
  seq,
  occurredAt: new Date().toISOString(),
  type: "assistant.text.delta",
  payload: { messageId: "live:1:3:1:0", text, phase },
});
const record = (offset: bigint, owner = scope): KafkaAcceptedFactRecord => ({
  topic: "review",
  partition: 0,
  offset,
  fact: {
    kind: "durable_commit",
    factId: `fact-${offset}`,
    scope: owner,
    occurredAt: new Date().toISOString(),
    commit: { seq: Number(offset), nextId: 2, writes: [] },
    origins: [],
    tools: [],
    cancellations: [],
    display: [],
  },
});
function response() {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    frames: [] as string[],
    write(chunk: string) {
      this.frames.push(chunk);
      return true;
    },
    destroy() {
      this.destroyed = true;
      this.emit("close");
    },
  });
}
const conversation = {
  turns: [{ turnId: scope.turnId, runId: scope.runId, state: "running" }],
} as ConversationDetailResource;
const facts: Record<string, unknown> = {};

// Exercise the actual admission -> hub -> open SSE view -> browser observation store.
{
  const live = new SessionLiveView(async () => {});
  const observations = new RunObservations(live.eventHub);
  const stream = new SessionEventStream(live, live.eventHub);
  const opened = await stream.open({
    tenantId: scope.tenantId,
    sessionId: scope.sessionId,
    loadCanonical: async () => ({ conversation, canonicalThroughSequence: 0 }),
  });
  const output = response();
  const piping = opened.pipe(output as unknown as ServerResponse);
  const publicFrames = () =>
    new SseFrameParser()
      .push(output.frames.join(""))
      .filter((f) => f.event?.startsWith("run."))
      .map((f) => JSON.parse(f.data) as RunObservation);
  const now = Date.now();
  try {
    await tick();
    observations.record(record(1n), true);
    observations.activity({
      scope,
      partition: 0,
      observedAt: now,
      lastActivityAt: now,
      revision: 100,
      phase: "waiting_model",
    });
    for (let i = 0; i < 10; i++)
      observations.execution(scope, {
        status: "confirmed",
        stage: "worker",
        bindingId: "old-binding",
        targetId: "old-vm",
        sentAt: now,
        confirmedAt: now,
      });
    await tick();
    const oldFrames = publicFrames();
    assert(oldFrames.some((f) => f.type === "run.activity" && f.revision === 100));
    assert(oldFrames.some((f) => f.type === "run.execution" && f.revision === 10));
    const browser = new RunObservationStore();
    const unsubscribe = browser.subscribe(scope.turnId, () => {});
    oldFrames.forEach((f) => browser.receive(f));
    const seal: KafkaAcceptedFactRecord = {
      ...record(2n),
      fact: {
        kind: "execution_seal",
        scope,
        factId: "review-seal",
        agentId: "root",
        baseSequence: 0,
        occurredAt: new Date().toISOString(),
        recover: true,
      },
    };
    observations.record(seal, false);
    observations.record(record(3n, nextScope), true);
    const before = publicFrames().length;
    const activity = {
      scope: nextScope,
      partition: 0,
      observedAt: Date.now(),
      lastActivityAt: Date.now(),
      revision: 1,
      phase: "executing_tool" as const,
    };
    observations.activity(activity);
    observations.execution(nextScope, {
      status: "confirmed",
      stage: "worker",
      bindingId: "new-binding",
      targetId: "new-vm",
      sentAt: Date.now(),
      confirmedAt: Date.now(),
    });
    await tick();
    assert.equal(observations.isActive(nextScope), true);
    assert.equal(observations.isActive(scope), false);
    const delivered = publicFrames().slice(before);
    assert(!delivered.some((f) => f.type === "run.activity" || f.type === "run.execution"));
    const newActivity: RunObservation = {
      type: "run.activity",
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      runId: scope.runId,
      revision: 1,
      phase: "executing_tool",
      observedAt: activity.observedAt,
      lastActivityAt: activity.lastActivityAt,
    };
    browser.receive(newActivity);
    assert.equal(browser.get(scope.turnId)?.activity?.phase, "waiting_model");
    const freshView = new RunObservationView(conversation);
    assert.equal(freshView.accept(newActivity), true);
    browser.reset();
    browser.receive(newActivity);
    assert.equal(browser.get(scope.turnId)?.activity?.phase, "executing_tool");
    unsubscribe();
    facts.writerReplacement = {
      newWriterAdmitted: true,
      oldWriterRejected: true,
      sameLogicalRun: true,
      oldActivityRevision: 100,
      oldExecutionRevision: 10,
      newActivityRevision: 1,
      newExecutionRevision: 1,
      newActivityAndExecutionDeliveredOnExistingSse: false,
      browserAlsoRejectsResetRevision: true,
      freshViewAcceptsNewActivity: true,
    };
  } finally {
    output.destroy();
    await piping;
    live.close();
  }
}

// A PG snapshot overtaking the captured tail must skip queued covered text.
{
  const live = new SessionLiveView(async () => {});
  const first = event(1, "partial");
  live.accept(scope.tenantId, first);
  const stream = new SessionEventStream(live, live.eventHub);
  const final = {
    ...event(2, "complete"),
    payload: {
      text: "complete",
      messageId: "live:1:3:1:0",
      settledMessageId: "entry:9:0",
      replace: true,
    },
  } as PiCloudEvent;
  const later = {
    ...event(3, "next"),
    payload: { text: "next", messageId: "live:1:4:1:0" },
  } as PiCloudEvent;
  const opened = await stream.open({
    tenantId: scope.tenantId,
    sessionId: scope.sessionId,
    loadCanonical: async () => {
      live.accept(scope.tenantId, final);
      live.cover(scope.tenantId, scope.sessionId, 2);
      live.accept(scope.tenantId, later);
      return {
        canonicalThroughSequence: 2,
        conversation: {
          ...conversation,
          turns: [
            {
              ...conversation.turns[0]!,
              transcript: projectConversationTurnTranscript([first, final]),
            },
          ],
        },
      };
    },
  });
  const output = response();
  const piping = opened.pipe(output as unknown as ServerResponse);
  try {
    await tick();
    const frames = new SseFrameParser().push(output.frames.join(""));
    const sent = frames
      .filter((f) => f.event === "assistant.text.delta")
      .map((f) => JSON.parse(f.data));
    assert.deepEqual(
      sent.map((e) => e.seq),
      [3],
    );
    const snapshot = JSON.parse(
      frames
        .filter((f) => f.event === "stream.part")
        .map((f) => JSON.parse(f.data))
        .join(""),
    );
    assert.equal(snapshot.conversation.turns[0].transcript.items[0].text, "complete");
    facts.snapshotOvertakesTail = {
      snapshotText: "complete",
      subsequentSequences: [3],
      duplicateText: false,
    };
  } finally {
    output.destroy();
    await piping;
    live.close();
  }
}

// Current queue bounds only count records; these are valid complete events.
{
  const hub = new SessionEventHub();
  const sub = hub.subscribe(scope.tenantId, scope.sessionId);
  let bodyBytes = 0,
    largestEventBytes = 0;
  for (let i = 1; i <= 128; i++) {
    const value = parsePiCloudEvent(
      JSON.parse(
        JSON.stringify({
          ...event(i, ""),
          type: "tool.started",
          payload: {
            toolCallId: `task:${i}`,
            toolName: "write",
            input: {
              path: `/workspace/fixture-${i}.txt`,
              content: String(i).padEnd(256 * 1024, "x"),
            },
          },
        }),
      ),
    );
    const bytes = Buffer.byteLength(JSON.stringify(value));
    assert(bytes < MAX_EXECUTION_FACT_BYTES);
    largestEventBytes = Math.max(largestEventBytes, bytes);
    bodyBytes += 256 * 1024;
    hub.publish(scope.tenantId, value);
  }
  for (let i = 1; i <= 128; i++) assert.equal((await sub.next())?.event?.seq, i);
  sub.close();
  hub.onApplicationShutdown();
  facts.slowReaderBudget = {
    queuedRecords: 128,
    queuedToolInputBytes: bodyBytes,
    largestEventBytes,
    resyncRequested: false,
    recordLimit: 1024,
    limitAtSameBodySizeBytes: 1024 * 256 * 1024,
    measuredHeapBytes: null,
  };
}

// Same stable text identity now streams in both phases, but only final coalesces.
{
  const commentary = new CompactEventTail(),
    final = new CompactEventTail();
  for (let i = 1; i <= 1000; i++) {
    commentary.accept(event(i, "abc", "commentary"));
    final.accept(event(i, "abc", "final_answer"));
  }
  assert.equal(commentary.text(), final.text());
  assert.equal(commentary.size, 1000);
  assert.equal(final.size, 1);
  facts.commentaryCompaction = {
    events: 1000,
    textCharacters: 3000,
    commentarySpans: commentary.size,
    finalSpans: final.size,
    commentaryEstimatedBytes: commentary.bytes,
    finalEstimatedBytes: final.bytes,
    bodyPreserved: true,
    estimationIncludesSpansOnly: true,
  };
}

const report = {
  reviewedRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  checkedAt: new Date().toISOString(),
  methodology:
    "In-process production modules with synthetic scoped records and an in-memory socket. No real Worker crash, PG/Kafka, browser transport or heap benchmark is claimed.",
  characterizationsPassed: Object.keys(facts).length,
  facts,
};
const path = process.argv[2];
if (path) await writeFile(path, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
