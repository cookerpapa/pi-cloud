import { describe, expect, it } from "vitest";
import {
  DomainTransitionError,
  transitionTurnControlRequest,
  transitionRun,
  transitionSandbox,
  transitionSession,
  transitionTurn,
  type SessionState,
  type TurnState,
} from "../src/index.ts";

function walkSession(initial: SessionState, transitions: readonly SessionState[]): SessionState {
  return transitions.reduce((state, next) => transitionSession(state, next), initial);
}

function walkTurn(initial: TurnState, transitions: readonly TurnState[]): TurnState {
  return transitions.reduce((state, next) => transitionTurn(state, next), initial);
}

describe("domain state machines", () => {
  it("admits one execution per Run and never requeues an interrupted Run", () => {
    expect(transitionRun("queued", "running")).toBe("running");
    expect(transitionRun("running", "settling")).toBe("settling");
    expect(transitionRun("settling", "completed")).toBe("completed");

    expect(transitionRun("running", "cancel_requested")).toBe("cancel_requested");
    expect(transitionRun("cancel_requested", "cancelled")).toBe("cancelled");

    expect(() => transitionRun("completed", "running")).toThrow(DomainTransitionError);
    expect(() => transitionRun("failed", "queued")).toThrow(DomainTransitionError);
    expect(() => transitionRun("cancelled", "running")).toThrow(DomainTransitionError);
  });

  it("walks a session through activation, cancellation, and eviction", () => {
    expect(walkSession("cold", ["starting", "idle", "running", "idle"])).toBe("idle");
    expect(walkSession("idle", ["running", "cancelling", "idle", "evicting", "cold"])).toBe("cold");
  });

  it("requires explicit session recovery after a failure", () => {
    expect(walkSession("running", ["failed", "recovering", "idle"])).toBe("idle");
    expect(() => transitionSession("failed", "idle")).toThrow(DomainTransitionError);
    expect(() => transitionSession("cold", "running")).toThrow(
      "Invalid session transition: cold -> running",
    );
  });

  it("walks a turn through execution and completion", () => {
    const state = walkTurn("queued", ["running", "completed"]);
    expect(state).toBe("completed");
    expect(() => transitionTurn("completed", "running")).toThrow(DomainTransitionError);
  });

  it.each(["queued", "running"] as const)(
    "cancels a %s turn through an explicit cancelling state",
    (from) => {
      expect(transitionTurn(transitionTurn(from, "cancelling"), "cancelled")).toBe("cancelled");
    },
  );

  it("does not requeue a Turn after execution has started", () => {
    expect(() => transitionTurn("running", "queued")).toThrow(DomainTransitionError);
    expect(transitionTurn("running", "failed")).toBe("failed");
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
    expect(() => transitionTurn("running", "running")).toThrow(DomainTransitionError);
  });
});
