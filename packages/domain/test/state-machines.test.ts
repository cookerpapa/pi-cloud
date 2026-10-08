import { describe, expect, it } from "vitest";
import {
  DomainTransitionError,
  transitionTurnControlRequest,
  transitionRun,
  transitionSandbox,
  transitionSession,
  turnStateForRun,
  type SessionState,
  type RunState,
} from "../src/index.ts";

function walkSession(initial: SessionState, transitions: readonly SessionState[]): SessionState {
  return transitions.reduce((state, next) => transitionSession(state, next), initial);
}

function walkRun(initial: RunState, transitions: readonly RunState[]): RunState {
  return transitions.reduce((state, next) => transitionRun(state, next), initial);
}

describe("domain state machines", () => {
  it("derives public Turn status from the one Run lifecycle", () => {
    expect(turnStateForRun("timed_out")).toBe("failed");
    expect(turnStateForRun("settling")).toBe("running");
    expect(turnStateForRun("cancel_requested")).toBe("cancelling");
  });

  it("admits one execution per Run and requires guarded recovery before readmission", () => {
    expect(transitionRun("queued", "running")).toBe("running");
    expect(transitionRun("running", "settling")).toBe("settling");
    expect(transitionRun("settling", "completed")).toBe("completed");

    expect(transitionRun("running", "cancel_requested")).toBe("cancel_requested");
    expect(transitionRun("cancel_requested", "cancelled")).toBe("cancelled");

    expect(() => transitionRun("completed", "running")).toThrow(DomainTransitionError);
    expect(() => transitionRun("failed", "queued")).toThrow(DomainTransitionError);
    expect(() => transitionRun("cancelled", "running")).toThrow(DomainTransitionError);
  });

  it("walks a Session through atomic admission, completion and cancellation", () => {
    expect(walkSession("cold", ["running", "idle"])).toBe("idle");
    expect(walkSession("idle", ["running", "cancelling", "idle"])).toBe("idle");
    expect(() => transitionSession("cold", "idle")).toThrow(DomainTransitionError);
  });

  it("models recovery as one guarded transition before another Run may be admitted", () => {
    expect(walkSession("running", ["failed", "idle", "running"])).toBe("running");
    expect(() => transitionSession("failed", "running")).toThrow(DomainTransitionError);
  });

  it("walks a turn through execution and completion", () => {
    const state = walkRun("queued", ["running", "completed"]);
    expect(state).toBe("completed");
    expect(() => transitionRun("completed", "running")).toThrow(DomainTransitionError);
  });

  it.each(["queued", "running"] as const)(
    "cancels a %s turn through an explicit cancelling state",
    (from) => {
      expect(transitionRun(transitionRun(from, "cancel_requested"), "cancelled")).toBe("cancelled");
    },
  );

  it("permits recovery admission while terminal Turns stay closed", () => {
    expect(transitionRun("running", "queued")).toBe("queued");
    expect(transitionRun("cancel_requested", "queued")).toBe("queued");
    expect(() => transitionRun("completed", "queued")).toThrow(DomainTransitionError);
    expect(transitionRun("running", "failed")).toBe("failed");
  });

  it("retries control requests only before acknowledgement", () => {
    expect(transitionTurnControlRequest("pending", "dispatched")).toBe("dispatched");
    expect(transitionTurnControlRequest("dispatched", "pending")).toBe("pending");
    expect(() => transitionTurnControlRequest("acknowledged", "pending")).toThrow(
      DomainTransitionError,
    );
  });

  it("makes completed and failed commands terminal", () => {
    expect(transitionTurnControlRequest("acknowledged", "completed")).toBe("completed");
    expect(transitionTurnControlRequest("dispatched", "failed")).toBe("failed");
    expect(() => transitionTurnControlRequest("completed", "failed")).toThrow(
      DomainTransitionError,
    );
  });

  it("readies, drains, and permanently terminates a Worker", () => {
    expect(transitionSandbox("provisioning", "ready")).toBe("ready");
    expect(transitionSandbox("ready", "draining")).toBe("draining");
    expect(transitionSandbox("draining", "terminated")).toBe("terminated");
    expect(() => transitionSandbox("terminated", "ready")).toThrow(DomainTransitionError);
  });

  it("allows failed sandbox cleanup without allowing reuse", () => {
    expect(transitionSandbox("ready", "failed")).toBe("failed");
    expect(transitionSandbox("failed", "terminated")).toBe("terminated");
    expect(() => transitionSandbox("failed", "ready")).toThrow(DomainTransitionError);
  });

  it("rejects self-transitions so duplicate delivery is handled by idempotency", () => {
    expect(() => transitionSession("idle", "idle")).toThrow(DomainTransitionError);
    expect(() => transitionRun("running", "running")).toThrow(DomainTransitionError);
  });
});
