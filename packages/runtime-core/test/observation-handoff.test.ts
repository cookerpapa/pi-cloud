import { EventEmitter } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import type { ServerResponse } from "node:http";
import { expect, it } from "vitest";
import {
  parseRunObservation,
  type ConversationDetailResource,
  type PiCloudEvent,
} from "@pi-cloud/protocol";
import type { KafkaAcceptedFactRecord } from "../src/kafka-accepted-fact-consumer.ts";
import { SessionLiveView } from "../src/session-live-view.ts";
import { SessionEventStream } from "../src/session-event-stream.ts";
import { RunObservations } from "../src/run-observations.ts";
import { RunObservationStore } from "../../web-ui/src/run-observation-store.ts";
import { SseFrameParser } from "../../web-ui/src/sse.ts";

const root = {
  tenantId: "tenant",
  sessionId: "root",
  turnId: "root-turn",
  runId: "root-run",
  writerId: "old",
  piSessionId: "physical",
  fencingToken: 7,
};
const child = { ...root, sessionId: "child", turnId: "child-turn" };
function record(offset: number, scope = root): KafkaAcceptedFactRecord {
  return {
    topic: "test",
    partition: 0,
    offset: BigInt(offset),
    fact: {
      kind: "durable_commit",
      factId: `fact-${offset}`,
      scope,
      occurredAt: new Date().toISOString(),
      commit: { seq: offset, nextId: 2, writes: [] },
      origins: [],
      tools: [],
      cancellations: [],
      display: [],
    },
  };
}
function response() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    destroyed: false,
    writableEnded: false,
    frames: [] as string[],
    write(value: string): boolean {
      this.frames.push(value);
      return true;
    },
    destroy() {
      this.destroyed = true;
      emitter.emit("close");
    },
  });
}
const observationsIn = (output: ReturnType<typeof response>) =>
  new SseFrameParser()
    .push(output.frames.join(""))
    .filter((frame) => frame.event?.startsWith("run."))
    .map((frame) => parseRunObservation(JSON.parse(frame.data)));

it("keeps root and child SSE open across writer handoff, resets all observations and rejects late old generations", async () => {
  const live = new SessionLiveView(async () => {});
  const source = new RunObservations(live.eventHub);
  const stream = new SessionEventStream(live, live.eventHub);
  const viewers = await Promise.all(
    [root, child].map(async (scope) => {
      const opened = await stream.open({
        tenantId: scope.tenantId,
        sessionId: scope.sessionId,
        loadCanonical: async () => ({
          canonicalThroughSequence: 0,
          conversation: {
            turns: [{ turnId: scope.turnId, runId: scope.runId, state: "running" }],
          } as ConversationDetailResource,
        }),
      });
      const output = response(),
        browser = new RunObservationStore();
      const unsubscribe = browser.subscribe(scope.turnId, () => {});
      return {
        scope,
        output,
        browser,
        unsubscribe,
        pipe: opened.pipe(output as unknown as ServerResponse),
      };
    }),
  );
  const activity = (
    scope: typeof root,
    revision: number,
    phase: "waiting_model" | "executing_tool",
  ) =>
    source.activity({
      scope,
      revision,
      phase,
      partition: 0,
      observedAt: Date.now(),
      lastActivityAt: Date.now(),
    });
  const execution = (scope: typeof root, targetId: string) =>
    source.execution(scope, {
      status: "confirmed",
      stage: "worker",
      bindingId: `binding-${targetId}`,
      targetId,
      sentAt: Date.now(),
      confirmedAt: Date.now(),
    });
  try {
    await tick();
    for (const [i, viewer] of viewers.entries()) {
      source.record(record(i + 1, viewer.scope), true);
      activity(viewer.scope, 100, "waiting_model");
      for (let n = 0; n < 10; n++) execution(viewer.scope, "old-vm");
    }
    await tick();
    for (const viewer of viewers) {
      observationsIn(viewer.output).forEach((value) => viewer.browser.receive(value));
      viewer.browser.toolProgress(viewer.scope.turnId);
      expect(viewer.browser.get(viewer.scope.turnId)).toMatchObject({
        generation: 7,
        activity: { revision: 100 },
        execution: { revision: 10 },
      });
      viewer.output.frames.length = 0;
    }
    source.record(
      {
        ...record(3),
        fact: {
          kind: "execution_seal",
          scope: root,
          factId: "seal",
          agentId: "root",
          baseSequence: 0,
          recover: true,
          occurredAt: new Date().toISOString(),
        },
      },
      false,
    );
    for (const [i, viewer] of viewers.entries()) {
      const next = { ...viewer.scope, writerId: "new", fencingToken: 8 };
      source.record(record(i + 4, next), true);
      activity(next, 1, "executing_tool");
      execution(next, "new-vm");
    }
    await tick();
    for (const viewer of viewers) {
      const delivered = observationsIn(viewer.output);
      expect(delivered.some((value) => value.type === "run.activity" && value.revision === 1)).toBe(
        true,
      );
      expect(
        delivered.some((value) => value.type === "run.execution" && value.revision === 1),
      ).toBe(true);
      expect(delivered.every((value) => value.generation === 8)).toBe(true);
      delivered.forEach((value) => viewer.browser.receive(value));
      expect(viewer.browser.get(viewer.scope.turnId)).toMatchObject({
        generation: 8,
        activity: { phase: "executing_tool", revision: 1 },
        execution: { execution: { targetId: "new-vm" } },
      });
      expect(viewer.browser.get(viewer.scope.turnId)?.toolActivityAt).toBeUndefined();
      expect(viewer.output.frames.join("")).not.toContain("stream.begin");
      expect(viewer.output.destroyed).toBe(false);
      activity(viewer.scope, 1000, "waiting_model"); // old trusted ingress scope
      const late = {
        ...delivered.find((value) => value.type === "run.activity")!,
        generation: 7,
        type: "run.activity" as const,
        revision: 1000,
        phase: "waiting_model" as const,
        observedAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      live.eventHub.publishObservation(viewer.scope.tenantId, late); // already-buffered old frame
      viewer.browser.receive(late);
      expect(viewer.browser.get(viewer.scope.turnId)?.activity?.phase).toBe("executing_tool");
      viewer.output.frames.length = 0;
    }
    await tick();
    for (const viewer of viewers) {
      expect(observationsIn(viewer.output)).toEqual([]);
      const terminal: PiCloudEvent = {
        schemaVersion: 1,
        eventId: "done",
        sessionId: viewer.scope.sessionId,
        turnId: viewer.scope.turnId,
        agentId: "root",
        seq: 1,
        occurredAt: new Date().toISOString(),
        type: "turn.completed",
        payload: { stopReason: "stop" },
      };
      live.accept(viewer.scope.tenantId, terminal);
      live.eventHub.publishObservation(viewer.scope.tenantId, {
        type: "run.activity",
        sessionId: viewer.scope.sessionId,
        turnId: viewer.scope.turnId,
        runId: root.runId,
        generation: 9,
        revision: 1,
        phase: "executing_tool",
        observedAt: Date.now(),
        lastActivityAt: Date.now(),
      });
    }
    await tick();
    for (const viewer of viewers) {
      expect(viewer.output.frames.join("")).toContain("turn.completed");
      expect(observationsIn(viewer.output)).toEqual([]);
    }
  } finally {
    for (const viewer of viewers) {
      viewer.output.destroy();
      viewer.unsubscribe();
    }
    await Promise.all(viewers.map((viewer) => viewer.pipe));
    live.close();
  }
});
