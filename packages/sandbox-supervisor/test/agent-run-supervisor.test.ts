import type {
  EventAckMessage,
  EventPublishMessage,
  CancelTurnCommandMessage,
  ExecuteTurnCommandMessage,
  SteerTurnCommandMessage,
} from "@pi-cloud/protocol";
import {
  createExecutionReference,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@pi-cloud/protocol";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  AgentRunSupervisor,
  PiTurnCancelledError,
  type SupervisorTurnRunner,
} from "../src/index.ts";

const IDS = {
  message: "11111111-1111-4111-8111-111111111111",
  command: "22222222-2222-4222-8222-222222222222",
  command2: "33333333-3333-4333-8333-333333333333",
  cancellation: "66666666-6666-4666-8666-666666666666",
  steer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  lease: "44444444-4444-4444-8444-444444444444",
  lease2: "55555555-5555-4555-8555-555555555555",
  boot: "88888888-8888-4888-8888-888888888888",
  connection: "99999999-9999-4999-8999-999999999999",
  heartbeatAck: "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa",
};

function command(
  overrides: {
    runId?: string;
    leaseId?: string;
    generation?: number;
    sessionId?: string;
    piSessionId?: string;
    lane?: string;
    attemptId?: string;
  } = {},
): ExecuteTurnCommandMessage {
  return {
    protocolVersion: 1,
    messageId: IDS.message,
    sentAt: "2026-07-18T08:00:00.000Z",
    type: "command.turn.execute",
    payload: {
      idempotencyKey: "request-1",
      tenantId: "tenant-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      sessionId: overrides.sessionId ?? "session-1",
      piSession: {
        id: overrides.piSessionId ?? overrides.sessionId ?? "session-1",
        lane: overrides.lane ?? "main",
        writerId: "00000000-0000-4000-8000-000000000001",
      },
      runId: overrides.runId ?? "40000000-0000-4000-8000-000000000001",
      turnId: "turn-1",
      agentId: "root",
      executionReference: createExecutionReference(
        overrides.leaseId ?? IDS.lease,
        overrides.attemptId ?? "50000000-0000-4000-8000-000000000001",
        overrides.generation ?? 1,
      ),
      nextEventSeq: 1,
      agent: {
        revisionId: "84041f7b-5052-4abf-8bfd-16adf083c67e",
        definitionKey: "pi-coding",
        runtimeKind: "pi_sdk",
        runtimeVersion: "0.84.1",
        harnessVersion: "pi-cloud-harness-v1",
        sessionStorageKind: "pi_session_storage_v1",
      },
      input: { kind: "prompt", text: "hello" },
      executionMode: "elastic",
      sessionKind: "conversation",
      workspaceSeedKind: "empty",
      sandboxProfileKey: "standard",
      workingDirectory: "/workspace",
      toolCapabilities: ["read", "write", "edit", "bash"],
      model: {
        profileId: "profile-1",
        provider: "pi-cloud-fake",
        modelId: "pi-cloud-fake",
        thinkingLevel: "off",
        serviceTier: null,
        credentialBindingId: "credential-1",
        credentialBindingVersion: 1,
      },
      environment: {
        environmentVersionId: "10000000-0000-4000-8000-000000000001",
        versionNumber: 1,
        profileKey: "pi-cloud-fullstack",
        profileVersion: "1",
        imageRevision: "development",
        specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
        recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
        recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
      },
    },
  };
}

function cancellation(target: ExecuteTurnCommandMessage = command()): CancelTurnCommandMessage {
  return {
    protocolVersion: 1,
    messageId: "77777777-7777-4777-8777-777777777777",
    sentAt: "2026-07-18T08:00:01.000Z",
    type: "command.turn.cancel",
    payload: {
      controlRequestId: IDS.cancellation,
      targetRunId: target.payload.runId,
      idempotencyKey: "cancel-1",
      tenantId: target.payload.tenantId,
      projectId: target.payload.projectId,
      workspaceId: target.payload.workspaceId,
      sessionId: target.payload.sessionId,
      runId: target.payload.runId,
      turnId: target.payload.turnId,
      agentId: target.payload.agentId,
      executionReference: target.payload.executionReference,
      reason: "user_request",
      gracePeriodMs: 50,
    },
  };
}

function steer(target: ExecuteTurnCommandMessage = command()): SteerTurnCommandMessage {
  return {
    protocolVersion: 1,
    messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    sentAt: "2026-07-18T08:00:01.000Z",
    type: "command.turn.steer",
    payload: {
      controlRequestId: IDS.steer,
      targetRunId: target.payload.runId,
      idempotencyKey: "steer-1",
      tenantId: target.payload.tenantId,
      projectId: target.payload.projectId,
      workspaceId: target.payload.workspaceId,
      sessionId: target.payload.sessionId,
      runId: target.payload.runId,
      turnId: target.payload.turnId,
      agentId: target.payload.agentId,
      executionReference: target.payload.executionReference,
      text: "Inspect the boundary condition first.",
    },
  };
}

class RecordingRunner implements SupervisorTurnRunner {
  readonly calls: ExecuteTurnCommandMessage[] = [];

  async run(value: ExecuteTurnCommandMessage): Promise<{ stopReason: string }> {
    this.calls.push(value);
    return { stopReason: "stop" };
  }
}

function rejectUnexpectedEvent(): never {
  throw new Error("Recording runner did not expect to publish an event");
}

describe("AgentRunSupervisor", () => {
  it("keeps a superseded Runner until its actual completion, even if PG is already closed", async () => {
    const finish = Promise.withResolvers<void>();
    const supervisor = new AgentRunSupervisor({
      runner: {
        async run() {
          await finish.promise;
          return { stopReason: "stop" };
        },
      },
    });
    const old = supervisor.prepare(command(), rejectUnexpectedEvent).run();
    const fresh = supervisor.prepare(
      command({ runId: IDS.command2, leaseId: IDS.lease2, generation: 2 }),
      rejectUnexpectedEvent,
    );
    try {
      expect(await supervisor.reapSettled(async (ids) => new Set(ids))).toBe(0);
      expect(supervisor.retainedState).toMatchObject({ runs: 2, families: 1 });
      finish.resolve();
      await old;
      expect(await supervisor.reapSettled(async (ids) => new Set(ids))).toBe(1);
      expect(supervisor.retainedState).toMatchObject({ runs: 1, families: 1 });
    } finally {
      finish.resolve();
      await old;
      fresh.releaseBeforeStart();
    }
  });

  it("retains duplicate outcomes until retirement is proven, then releases Run/control payloads", async () => {
    const finish = Promise.withResolvers<void>();
    let calls = 0;
    const supervisor = new AgentRunSupervisor({
      runner: {
        async run() {
          calls++;
          await finish.promise;
          return { stopReason: "stop" };
        },
        async steer() {},
      },
    });
    const execute = command();
    const prepared = supervisor.prepare(execute, rejectUnexpectedEvent);
    const run = prepared.run();
    const steering = supervisor.prepareSteer(steer(execute));
    await steering.run();
    supervisor.prepareCancellation(cancellation(execute));
    expect(await supervisor.reapSettled(async (ids) => new Set(ids))).toBe(0);
    finish.resolve();
    await run;
    const retained = { runs: 1, steers: 1, cancellations: 1, families: 1 };
    expect(supervisor.retainedState).toEqual(retained);
    expect(await supervisor.reapSettled(async () => new Set())).toBe(0);
    await expect(
      supervisor.reapSettled(async () => {
        throw new Error("database unavailable");
      }),
    ).rejects.toThrow("database unavailable");
    expect(supervisor.retainedState).toEqual(retained);
    const duplicate = supervisor.prepare(execute, rejectUnexpectedEvent);
    expect(duplicate.ack.payload.status).toBe("duplicate");
    await duplicate.run();
    expect(calls).toBe(1);
    expect(await supervisor.reapSettled(async (ids) => new Set(ids))).toBe(1);
    expect(supervisor.retainedState).toEqual({ runs: 0, steers: 0, cancellations: 0, families: 0 });
    await prepared.run();
    expect(calls).toBe(1);
    expect(supervisor.prepareSteer(steer(execute)).ack.payload).toMatchObject({
      status: "rejected",
      code: "invalid_state",
    });
  });

  it("does not retire a new family owner while an old retirement check is pending", async () => {
    const finish = Promise.withResolvers<void>();
    const old = command();
    const fresh = command({ runId: IDS.command2, leaseId: IDS.lease2, generation: 2 });
    const supervisor = new AgentRunSupervisor({
      runner: {
        async run(value) {
          if (value.payload.runId === fresh.payload.runId) await finish.promise;
          return { stopReason: "stop" };
        },
      },
    });
    await supervisor.prepare(old, rejectUnexpectedEvent).run();
    const checked = Promise.withResolvers<ReadonlySet<string>>();
    const reap = supervisor.reapSettled(() => checked.promise);
    const active = supervisor.prepare(fresh, rejectUnexpectedEvent).run();
    checked.resolve(new Set([old.payload.runId]));
    expect(await reap).toBe(1);
    expect(supervisor.retainedState).toMatchObject({ runs: 1, families: 1 });
    const stale = command({
      runId: IDS.command,
      sessionId: "late-child",
      piSessionId: "session-1",
      lane: "late",
    });
    expect(supervisor.prepare(stale, rejectUnexpectedEvent).ack.payload).toMatchObject({
      status: "rejected",
      code: "stale_session_lease",
    });
    finish.resolve();
    await active;
    await supervisor.reapSettled(async (ids) => new Set(ids));
    expect(supervisor.retainedState).toMatchObject({ runs: 0, families: 0 });
  });

  it("releases completed command objects and pre-start owner bookkeeping after authoritative retirement", () => {
    const source = `
      import {AgentRunSupervisor} from ${JSON.stringify(new URL("../src/agent-run-supervisor.ts", import.meta.url).href)};
      import {setImmediate as tick} from 'node:timers/promises';
      const refs=[];
      const supervisor=new AgentRunSupervisor({runner:{run:async command=>{refs.push(new WeakRef(command));return {stopReason:'stop'};}}});
      const template=${JSON.stringify(command())};
      async function complete(i){
        await supervisor.prepare({...template,payload:{...template.payload,runId:'40000000-0000-4000-8000-'+String(i).padStart(12,'0')}},()=>{}).run();
      }
      for(let i=0;i<16;i++)await complete(i);
      for(let i=0;i<5;i++){await tick();global.gc();}
      const before=refs.filter(ref=>ref.deref()!==undefined).length;
      await supervisor.reapSettled(async ids=>new Set(ids));
      for(let i=0;i<5;i++){await tick();global.gc();}
      const after=refs.filter(ref=>ref.deref()!==undefined).length;
      supervisor.prepare(template,()=>{}).releaseBeforeStart();
      await supervisor.reapSettled(async ids=>new Set(ids));
      console.log(JSON.stringify({before,after,retained:supervisor.retainedState}));
    `;
    const result = execFileSync(
      process.execPath,
      ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", source],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(result)).toEqual({
      before: 16,
      after: 0,
      retained: { runs: 0, steers: 0, cancellations: 0, families: 0 },
    });
  });

  it("releases a slot when the runner throws before returning a promise", async () => {
    const supervisor = new AgentRunSupervisor({
      runner: {
        run() {
          throw new Error("synchronous startup failure");
        },
      },
    });
    const prepared = supervisor.prepare(command(), rejectUnexpectedEvent);
    await expect(async () => prepared.run()).rejects.toThrow("synchronous startup failure");
    expect(supervisor.activeSessionCount).toBe(0);
  });

  it("does not retain a completed Run's publisher and its runtime context", () => {
    const source = `
      import {AgentRunSupervisor} from ${JSON.stringify(new URL("../src/agent-run-supervisor.ts", import.meta.url).href)};
      import {setImmediate as tick} from 'node:timers/promises';
      const supervisor=new AgentRunSupervisor({runner:{run:async()=>({stopReason:'stop'})}});
      const template=${JSON.stringify(command())};
      const references=[];
      async function complete(i){
        const context=new Uint8Array(1024);
        const publisher=()=>{throw new Error(String(context.length));};
        references.push(new WeakRef(publisher));
        await supervisor.prepare({...template,payload:{...template.payload,runId:'40000000-0000-4000-8000-'+String(i).padStart(12,'0')}},publisher).run();
      }
      for(let i=0;i<16;i++)await complete(i);
      for(let i=0;i<5;i++){await tick();global.gc();}
      console.log(JSON.stringify({retained:references.filter(ref=>ref.deref()!==undefined).length,active:supervisor.activeSessionCount}));
    `;
    const result = execFileSync(
      process.execPath,
      ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", source],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(result)).toEqual({ retained: 0, active: 0 });
  });
  it("returns a side-effect-free ACK and starts the runner only after run", async () => {
    const runner = new RecordingRunner();
    const supervisor = new AgentRunSupervisor({ runner });
    const prepared = supervisor.prepare(command(), rejectUnexpectedEvent);

    expect(prepared.ack.payload).toMatchObject({ status: "accepted" });
    expect(runner.calls).toHaveLength(0);
    expect(supervisor.activeSessionCount).toBe(1);

    await expect(prepared.run()).resolves.toEqual({ stopReason: "stop", lastEventSeq: 0 });
    expect(runner.calls).toHaveLength(1);
    expect(supervisor.activeSessionCount).toBe(0);
  });

  it("deduplicates the same command and reuses one execution promise", async () => {
    const runner = new RecordingRunner();
    const supervisor = new AgentRunSupervisor({ runner });
    const first = supervisor.prepare(command(), rejectUnexpectedEvent);
    const duplicate = supervisor.prepare(command(), rejectUnexpectedEvent);

    expect(duplicate.ack.payload.status).toBe("duplicate");
    await Promise.all([first.run(), duplicate.run()]);
    const settledDuplicate = supervisor.prepare(command(), rejectUnexpectedEvent);
    expect(settledDuplicate.ack.payload.status).toBe("duplicate");
    await expect(settledDuplicate.run()).resolves.toEqual({ stopReason: "stop", lastEventSeq: 0 });
    expect(runner.calls).toHaveLength(1);
  });

  it("rejects a reused command ID when the immutable payload changed", () => {
    const runner = new RecordingRunner();
    const supervisor = new AgentRunSupervisor({ runner });
    supervisor.prepare(command(), rejectUnexpectedEvent);
    const changed = command();
    if (changed.payload.input.kind !== "prompt") throw new Error("Expected prompt input");
    changed.payload.input.text = "different prompt";

    const conflict = supervisor.prepare(changed, rejectUnexpectedEvent);
    expect(conflict.ack.payload).toMatchObject({
      status: "rejected",
      code: "invalid_command",
      retryable: false,
    });
  });

  it("retains the high-water fencing token after a pre-start release", () => {
    const runner = new RecordingRunner();
    const supervisor = new AgentRunSupervisor({ runner });
    const current = supervisor.prepare(
      command({ leaseId: IDS.lease2, generation: 2 }),
      rejectUnexpectedEvent,
    );
    current.releaseBeforeStart();

    const stale = supervisor.prepare(command({ generation: 1 }), rejectUnexpectedEvent);
    expect(stale.ack.payload).toMatchObject({
      status: "rejected",
      code: "stale_session_lease",
      retryable: false,
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects capacity overflow without invoking the second command", () => {
    const runner = new RecordingRunner();
    const supervisor = new AgentRunSupervisor({ runner, maxConcurrentSessions: 1 });
    supervisor.prepare(command(), rejectUnexpectedEvent);
    const overflow = supervisor.prepare(
      command({
        runId: IDS.command2,
        leaseId: IDS.lease2,
        sessionId: "session-2",
      }),
      rejectUnexpectedEvent,
    );

    expect(overflow.ack.payload).toMatchObject({
      status: "rejected",
      code: "capacity",
      retryable: true,
    });
  });

  it("rejects runner events with a mismatched ExecutionReference", async () => {
    const badRunner: SupervisorTurnRunner = {
      async run(value, publishEvent) {
        const event = {
          protocolVersion: 1,
          messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sentAt: "2026-07-18T08:00:00.000Z",
          type: "event.publish",
          payload: {
            executionReference: createExecutionReference(
              IDS.lease2,
              "50000000-0000-4000-8000-000000000001",
              2,
            ),
            event: {
              schemaVersion: 1,
              eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              sessionId: value.payload.sessionId,
              turnId: value.payload.turnId,
              agentId: "root",
              seq: 1,
              occurredAt: "2026-07-18T08:00:00.000Z",
              type: "turn.started",
              payload: { inputKind: "prompt" },
            },
          },
        } as EventPublishMessage;
        await publishEvent(event);
        return { stopReason: "stop" };
      },
    };
    const supervisor = new AgentRunSupervisor({ runner: badRunner });
    const prepared = supervisor.prepare(command(), rejectUnexpectedEvent);

    await expect(prepared.run()).rejects.toThrow("does not match its assignment");
  });

  it("rejects an acknowledgement that does not match the published event", async () => {
    const publishingRunner: SupervisorTurnRunner = {
      async run(value, publishEvent) {
        await publishEvent({
          protocolVersion: 1,
          messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sentAt: "2026-07-18T08:00:00.000Z",
          type: "event.publish",
          payload: {
            executionReference: value.payload.executionReference,
            event: {
              schemaVersion: 1,
              eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              sessionId: value.payload.sessionId,
              turnId: value.payload.turnId,
              agentId: "root",
              seq: 1,
              occurredAt: "2026-07-18T08:00:00.000Z",
              type: "turn.started",
              payload: { inputKind: "prompt" },
            },
          },
        });
        return { stopReason: "stop" };
      },
    };
    const supervisor = new AgentRunSupervisor({ runner: publishingRunner });
    const prepared = supervisor.prepare(command(), (message): EventAckMessage => ({
      protocolVersion: 1,
      messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      sentAt: "2026-07-18T08:00:00.000Z",
      type: "event.ack",
      payload: {
        sessionId: message.payload.event.sessionId,
        executionReference: message.payload.executionReference,
        acknowledgedThroughSeq: 2,
      },
    }));

    await expect(prepared.run()).rejects.toThrow(
      "acknowledgement did not match the published event",
    );
  });

  it("allows public-event sequence gaps occupied by native Session records", async () => {
    const publishingRunner: SupervisorTurnRunner = {
      async run(value, publishEvent) {
        for (const seq of [1, 3]) {
          await publishEvent({
            protocolVersion: 1,
            messageId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(seq).padStart(12, "0")}`,
            sentAt: "2026-07-18T08:00:00.000Z",
            type: "event.publish",
            payload: {
              executionReference: value.payload.executionReference,
              event: {
                schemaVersion: 1,
                eventId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(seq).padStart(12, "0")}`,
                sessionId: value.payload.sessionId,
                turnId: value.payload.turnId,
                agentId: "root",
                seq,
                occurredAt: "2026-07-18T08:00:00.000Z",
                type: "turn.started",
                payload: { inputKind: "prompt" },
              },
            },
          });
        }
        return { stopReason: "stop" };
      },
    };
    const supervisor = new AgentRunSupervisor({ runner: publishingRunner });
    const prepared = supervisor.prepare(command(), (message): EventAckMessage => ({
      protocolVersion: 1,
      messageId: globalThis.crypto.randomUUID(),
      sentAt: "2026-07-18T08:00:00.000Z",
      type: "event.ack",
      payload: {
        sessionId: message.payload.event.sessionId,
        executionReference: message.payload.executionReference,
        acknowledgedThroughSeq: message.payload.event.seq,
      },
    }));

    await expect(prepared.run()).resolves.toEqual({ stopReason: "stop", lastEventSeq: 3 });
  });

  it("prepares cancellation without side effects, then aborts the exact running assignment", async () => {
    let observedSignal: AbortSignal | undefined;
    const abortingRunner: SupervisorTurnRunner = {
      async run(_value, _publishEvent, signal) {
        observedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const reason = signal.reason as { reason: "user_request" };
              reject(new PiTurnCancelledError(reason.reason, false));
            },
            { once: true },
          );
        });
      },
    };
    const supervisor = new AgentRunSupervisor({ runner: abortingRunner });
    const execute = command();
    const preparedExecution = supervisor.prepare(execute, rejectUnexpectedEvent);
    const execution = preparedExecution.run();
    void execution.catch(() => undefined);
    const preparedCancellation = supervisor.prepareCancellation(cancellation(execute));

    expect(preparedCancellation.ack.payload.status).toBe("accepted");
    expect(observedSignal?.aborted).toBe(false);
    await expect(preparedCancellation.run()).resolves.toEqual({
      reason: "user_request",
      forced: false,
      lastEventSeq: 0,
    });
    await expect(execution).rejects.toBeInstanceOf(PiTurnCancelledError);
    expect(observedSignal?.aborted).toBe(true);
    expect(supervisor.activeSessionCount).toBe(0);
  });

  it("delivers a fenced steer only to the exact running assignment", async () => {
    let settle!: () => void;
    const observed: Array<{ targetRunId: string; text: string }> = [];
    const steeringRunner: SupervisorTurnRunner = {
      async run() {
        await new Promise<void>((resolvePromise) => {
          settle = resolvePromise;
        });
        return { stopReason: "stop" };
      },
      async steer(targetRunId, text) {
        observed.push({ targetRunId, text });
      },
    };
    const supervisor = new AgentRunSupervisor({ runner: steeringRunner });
    const execute = command();
    const execution = supervisor.prepare(execute, rejectUnexpectedEvent).run();
    const preparedSteer = supervisor.prepareSteer(steer(execute));

    expect(preparedSteer.ack.payload.status).toBe("accepted");
    expect(observed).toEqual([]);
    await expect(preparedSteer.run()).resolves.toBeUndefined();
    expect(observed).toEqual([
      {
        targetRunId: execute.payload.runId,
        text: "Inspect the boundary condition first.",
      },
    ]);
    settle();
    await expect(execution).resolves.toEqual({ stopReason: "stop", lastEventSeq: 0 });
  });

  it("reports a running assignment and applies only its exact heartbeat renewal", async () => {
    const clock = () => new Date("2026-07-18T08:00:00.000Z");
    const abortingRunner: SupervisorTurnRunner = {
      async run(_value, _publishEvent, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const reason = signal.reason as { reason: "session_lease_revoked" };
              reject(new PiTurnCancelledError(reason.reason, false));
            },
            { once: true },
          );
        });
      },
    };
    const supervisor = new AgentRunSupervisor({ runner: abortingRunner, clock });
    const prepared = supervisor.prepare(command(), rejectUnexpectedEvent);
    const execution = prepared.run();
    void execution.catch(() => undefined);
    const heartbeat = supervisor.createHeartbeat({
      supervisorId: "supervisor-1",
      bootId: IDS.boot,
      connectionId: IDS.connection,
    });

    expect(heartbeat.payload.families).toEqual([
      {
        tenantId: "tenant-1",
        piSessionId: "session-1",
        leaseId: IDS.lease,
        writerId: command().payload.piSession.writerId,
        fencingToken: 1,
      },
    ]);
    expect(
      supervisor.applyHeartbeatAcknowledgement(heartbeat, {
        protocolVersion: 1,
        messageId: IDS.heartbeatAck,
        sentAt: "2026-07-18T08:00:00.000Z",
        type: "supervisor.heartbeat.ack",
        payload: {
          acknowledgedMessageId: heartbeat.messageId,
          connectionId: IDS.connection,
          familyLeaseRenewals: [
            {
              leaseId: IDS.lease,
              fencingToken: 1,
              validUntil: "2026-07-18T08:01:00.000Z",
            },
          ],
        },
      }),
    ).toEqual({
      renewedAssignments: 1,
      revokedAssignments: 0,
      revokedSessionIds: [],
    });

    prepared.revokeExecution();
    await expect(execution).rejects.toMatchObject({ reason: "session_lease_revoked" });
    expect(supervisor.activeSessionCount).toBe(0);
  });

  it("uses one family slot/renewal and cancels only the requested sibling task", async () => {
    const signals = new Map<string, AbortSignal>();
    const runtime = new AgentRunSupervisor({
      maxConcurrentSessions: 1,
      runner: {
        run: async (value, _publish, signal) => {
          signals.set(value.payload.sessionId, signal);
          return new Promise((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  new PiTurnCancelledError(
                    (signal.reason as { reason: "user_request" }).reason,
                    false,
                  ),
                ),
              { once: true },
            ),
          );
        },
      },
    });
    const parentCommand = command(),
      childCommand = command({
        runId: IDS.command2,
        attemptId: IDS.command2,
        sessionId: "child-scope",
        piSessionId: "session-1",
        lane: "child",
      });
    const parent = runtime.prepare(parentCommand, rejectUnexpectedEvent),
      child = runtime.prepare(childCommand, rejectUnexpectedEvent);
    expect(child.ack.payload.status).toBe("accepted");
    const parentRun = parent.run(),
      childRun = child.run();
    void parentRun.catch(() => {});
    void childRun.catch(() => {});
    expect(runtime.activeSessionCount).toBe(1);
    expect(
      runtime.createHeartbeat({
        supervisorId: "supervisor-1",
        bootId: IDS.boot,
        connectionId: IDS.connection,
      }).payload.families,
    ).toHaveLength(1);
    const cancelled = runtime.prepareCancellation(cancellation(childCommand));
    await cancelled.run();
    await expect(childRun).rejects.toBeInstanceOf(PiTurnCancelledError);
    expect(signals.get("session-1")?.aborted).toBe(false);
    expect(runtime.activeSessionCount).toBe(1);
    parent.revokeExecution();
    await expect(parentRun).rejects.toBeInstanceOf(PiTurnCancelledError);
  });

  it.each([0, 61000])(
    "checks one family heartbeat batch after %i ms in transit",
    async (elapsed) => {
      let monotonic = 0;
      const abortingRunner: SupervisorTurnRunner = {
        async run(_value, _publishEvent, signal) {
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                const reason = signal.reason as { reason: "session_lease_revoked" };
                reject(new PiTurnCancelledError(reason.reason, false));
              },
              { once: true },
            );
          });
        },
      };
      const supervisor = new AgentRunSupervisor({
        runner: abortingRunner,
        maxConcurrentSessions: 2,
        clock: () => new Date("2026-07-18T08:00:00.000Z"),
        monotonicNow: () => monotonic,
      });
      const first = supervisor.prepare(command(), rejectUnexpectedEvent);
      const second = supervisor.prepare(
        command({
          runId: IDS.command2,
          leaseId: IDS.lease2,
          generation: 2,
          sessionId: "session-2",
        }),
        rejectUnexpectedEvent,
      );
      const executions = [first.run(), second.run()];
      for (const execution of executions) void execution.catch(() => undefined);
      const heartbeat = supervisor.createHeartbeat({
        supervisorId: "supervisor-1",
        bootId: IDS.boot,
        connectionId: IDS.connection,
      });

      expect(heartbeat.payload.families.map((value) => value.piSessionId).sort()).toEqual([
        "session-1",
        "session-2",
      ]);
      monotonic = elapsed;
      expect(
        supervisor.applyHeartbeatAcknowledgement(heartbeat, {
          protocolVersion: 1,
          messageId: IDS.heartbeatAck,
          sentAt: "2026-07-18T08:00:01.000Z",
          type: "supervisor.heartbeat.ack",
          payload: {
            acknowledgedMessageId: heartbeat.messageId,
            connectionId: IDS.connection,
            familyLeaseRenewals: heartbeat.payload.families.map((value) => ({
              leaseId: value.leaseId,
              fencingToken: value.fencingToken,
              validUntil: "2026-07-18T08:01:00.000Z",
            })),
          },
        }),
      ).toEqual({
        renewedAssignments: elapsed === 0 ? 2 : 0,
        revokedAssignments: elapsed === 0 ? 0 : 2,
        revokedSessionIds: elapsed === 0 ? [] : ["session-1", "session-2"],
      });

      first.revokeExecution();
      second.revokeExecution();
      await Promise.all(executions.map((execution) => expect(execution).rejects.toBeDefined()));
      expect(supervisor.activeSessionCount).toBe(0);
    },
  );

  it("revokes a running assignment when its heartbeat ACK omits the renewal", async () => {
    let observedSignal: AbortSignal | undefined;
    const abortingRunner: SupervisorTurnRunner = {
      async run(_value, _publishEvent, signal) {
        observedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const reason = signal.reason as { reason: "session_lease_revoked" };
              reject(new PiTurnCancelledError(reason.reason, false));
            },
            { once: true },
          );
        });
      },
    };
    const supervisor = new AgentRunSupervisor({ runner: abortingRunner });
    const prepared = supervisor.prepare(command(), rejectUnexpectedEvent);
    const execution = prepared.run();
    void execution.catch(() => undefined);
    const heartbeat = supervisor.createHeartbeat({
      supervisorId: "supervisor-1",
      bootId: IDS.boot,
      connectionId: IDS.connection,
    });

    expect(
      supervisor.applyHeartbeatAcknowledgement(heartbeat, {
        protocolVersion: 1,
        messageId: IDS.heartbeatAck,
        sentAt: "2026-07-18T08:00:01.000Z",
        type: "supervisor.heartbeat.ack",
        payload: {
          acknowledgedMessageId: heartbeat.messageId,
          connectionId: IDS.connection,
          familyLeaseRenewals: [],
        },
      }),
    ).toEqual({
      renewedAssignments: 0,
      revokedAssignments: 1,
      revokedSessionIds: ["session-1"],
    });
    expect(observedSignal?.reason).toMatchObject({
      reason: "session_lease_revoked",
      gracePeriodMs: 0,
    });
    await expect(execution).rejects.toMatchObject({ reason: "session_lease_revoked" });
    expect(supervisor.activeSessionCount).toBe(0);
  });

  it("does not report success when a runner ignores lease revocation", async () => {
    let releaseRunner: (() => void) | undefined;
    const gate = new Promise<void>((resolvePromise) => {
      releaseRunner = resolvePromise;
    });
    const supervisor = new AgentRunSupervisor({
      runner: {
        async run() {
          await gate;
          return { stopReason: "ignored_abort" };
        },
      },
    });
    const prepared = supervisor.prepare(command(), rejectUnexpectedEvent);
    const execution = prepared.run();
    void execution.catch(() => undefined);

    prepared.revokeExecution();
    releaseRunner?.();
    await expect(execution).rejects.toMatchObject({
      code: "session_lease_revocation_not_confirmed",
    });
    expect(supervisor.activeSessionCount).toBe(0);
  });

  it("does not report assignment settlement until revoked runner teardown finishes", async () => {
    let finishTeardown: (() => void) | undefined;
    const teardownGate = new Promise<void>((resolvePromise) => {
      finishTeardown = resolvePromise;
    });
    let abortObserved = false;
    const supervisor = new AgentRunSupervisor({
      runner: {
        async run(_command, _publishEvent, signal) {
          if (!signal.aborted) {
            await new Promise<void>((resolvePromise) =>
              signal.addEventListener("abort", () => resolvePromise(), { once: true }),
            );
          }
          abortObserved = true;
          await teardownGate;
          throw new PiTurnCancelledError("session_lease_revoked", false);
        },
      },
    });
    const execution = supervisor.prepare(command(), rejectUnexpectedEvent).run();
    void execution.catch(() => undefined);
    let settled = false;
    const settlement = supervisor.waitUntilAssignmentsSettled().then(() => {
      settled = true;
    });

    expect(supervisor.revokeAllAssignments()).toEqual({
      releasedPreparations: 0,
      releasedCancellations: 0,
      releasedSteers: 0,
      revokedExecutions: 1,
    });
    await Promise.resolve();
    expect(abortObserved).toBe(true);
    expect(settled).toBe(false);

    finishTeardown?.();
    await settlement;
    await expect(execution).rejects.toMatchObject({ reason: "session_lease_revoked" });
    expect(settled).toBe(true);
    expect(supervisor.activeSessionCount).toBe(0);
  });
});
