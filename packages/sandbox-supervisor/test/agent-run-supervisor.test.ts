import type {
  EventAckMessage,
  EventPublishMessage,
  CancelTurnCommandMessage,
  ExecuteTurnCommandMessage,
  SteerTurnCommandMessage,
} from "@pi-cloud/protocol";
import {
  createExecutionLease,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@pi-cloud/protocol";
import { describe, expect, it } from "vitest";
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
    grantId?: string;
    generation?: number;
    sessionId?: string;
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
      runId: overrides.runId ?? "40000000-0000-4000-8000-000000000001",
      turnId: "turn-1",
      agentId: "root",
      executionLease: createExecutionLease(
        overrides.grantId ?? IDS.lease,
        "50000000-0000-4000-8000-000000000001",
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
      sandboxProfileKey: "standard",
      workingDirectory: "/workspace",
      toolCapabilities: ["read", "write", "edit", "bash"],
      model: {
        profileId: "profile-1",
        provider: "pi-cloud-fake",
        modelId: "pi-cloud-fake",
        thinkingLevel: "off",
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
      executionLease: target.payload.executionLease,
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
      executionLease: target.payload.executionLease,
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
      command({ grantId: IDS.lease2, generation: 2 }),
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
        grantId: IDS.lease2,
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

  it("rejects runner events with a mismatched ExecutionLease", async () => {
    const badRunner: SupervisorTurnRunner = {
      async run(value, publishEvent) {
        const event = {
          protocolVersion: 1,
          messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sentAt: "2026-07-18T08:00:00.000Z",
          type: "event.publish",
          payload: {
            executionLease: createExecutionLease(
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
            executionLease: value.payload.executionLease,
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
        executionLease: message.payload.executionLease,
        acknowledgedThroughSeq: 2,
      },
    }));

    await expect(prepared.run()).rejects.toThrow(
      "acknowledgement did not match the published event",
    );
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

    expect(heartbeat.payload.sessions).toEqual([
      {
        sessionId: "session-1",
        turnId: "turn-1",
        state: "running",
        executionLease: command().payload.executionLease,
        lastProducedSeq: 0,
        lastAcknowledgedSeq: 0,
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
          executionLeaseRenewals: [
            {
              sessionId: "session-1",
              executionLease: command().payload.executionLease,
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

    prepared.revokeLease();
    await expect(execution).rejects.toMatchObject({ reason: "session_lease_revoked" });
    expect(supervisor.activeSessionCount).toBe(0);
  });

  it("batches every active session into one supervisor heartbeat", async () => {
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
    });
    const first = supervisor.prepare(command(), rejectUnexpectedEvent);
    const second = supervisor.prepare(
      command({
        runId: IDS.command2,
        grantId: IDS.lease2,
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

    expect(heartbeat.payload.sessions.map((value) => value.sessionId).sort()).toEqual([
      "session-1",
      "session-2",
    ]);
    expect(
      supervisor.applyHeartbeatAcknowledgement(heartbeat, {
        protocolVersion: 1,
        messageId: IDS.heartbeatAck,
        sentAt: "2026-07-18T08:00:01.000Z",
        type: "supervisor.heartbeat.ack",
        payload: {
          acknowledgedMessageId: heartbeat.messageId,
          connectionId: IDS.connection,
          executionLeaseRenewals: heartbeat.payload.sessions.map((value) => ({
            sessionId: value.sessionId,
            executionLease: value.executionLease,
            validUntil: "2026-07-18T08:01:00.000Z",
          })),
        },
      }),
    ).toEqual({
      renewedAssignments: 2,
      revokedAssignments: 0,
      revokedSessionIds: [],
    });

    first.revokeLease();
    second.revokeLease();
    await Promise.all(executions.map((execution) => expect(execution).rejects.toBeDefined()));
    expect(supervisor.activeSessionCount).toBe(0);
  });

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
          executionLeaseRenewals: [],
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

    prepared.revokeLease();
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
