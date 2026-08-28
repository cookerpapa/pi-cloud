import { describe, expect, it } from "vitest";
import {
  DomainTransitionError,
  canTransitionTurnControlRequest,
  canTransitionTurn,
  isTerminalTurnControlRequestState,
  isTerminalSandboxState,
  isTerminalTurnState,
  transitionTurnControlRequest,
  transitionRun,
  transitionRunAttempt,
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
  it("enforces durable run and attempt phases", () => {
    expect(transitionRun("queued", "claimed")).toBe("claimed");
    expect(transitionRun("claimed", "provisioning")).toBe("provisioning");
    expect(transitionRun("provisioning", "restoring")).toBe("restoring");
    expect(transitionRun("restoring", "running")).toBe("running");
    expect(transitionRun("running", "checkpointing")).toBe("checkpointing");
    expect(transitionRun("checkpointing", "completed")).toBe("completed");

    expect(transitionRunAttempt("claimed", "provisioning")).toBe("provisioning");
    expect(transitionRunAttempt("provisioning", "running")).toBe("running");
    expect(transitionRunAttempt("running", "cancel_requested")).toBe("cancel_requested");
    expect(transitionRunAttempt("cancel_requested", "cancelled")).toBe("cancelled");

    expect(() => transitionRun("completed", "running")).toThrow(DomainTransitionError);
    expect(() => transitionRunAttempt("superseded", "running")).toThrow(DomainTransitionError);
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
    expect(isTerminalTurnState(state)).toBe(true);
    expect(() => transitionTurn("completed", "running")).toThrow(DomainTransitionError);
  });

  it.each(["queued", "running"] as const)(
    "cancels a %s turn through an explicit cancelling state",
    (from) => {
      expect(transitionTurn(transitionTurn(from, "cancelling"), "cancelled")).toBe("cancelled");
    },
  );

  it("does not requeue a Turn after execution has started", () => {
    expect(canTransitionTurn("running", "queued")).toBe(false);
    expect(() => transitionTurn("running", "queued")).toThrow(DomainTransitionError);
    expect(transitionTurn("running", "failed")).toBe("failed");
  });

  it("retries control requests only before acknowledgement", () => {
    expect(transitionTurnControlRequest("pending", "dispatched")).toBe("dispatched");
    expect(transitionTurnControlRequest("dispatched", "pending")).toBe("pending");
    expect(canTransitionTurnControlRequest("acknowledged", "pending")).toBe(false);
    expect(() => transitionTurnControlRequest("acknowledged", "pending")).toThrow(
      DomainTransitionError,
    );
  });

  it("makes completed and failed commands terminal", () => {
    expect(
      isTerminalTurnControlRequestState(
        transitionTurnControlRequest(
          transitionTurnControlRequest("pending", "dispatched"),
          "acknowledged",
        ),
      ),
    ).toBe(false);
    expect(
      isTerminalTurnControlRequestState(transitionTurnControlRequest("acknowledged", "completed")),
    ).toBe(true);
    expect(
      isTerminalTurnControlRequestState(transitionTurnControlRequest("dispatched", "failed")),
    ).toBe(true);
    expect(() => transitionTurnControlRequest("completed", "failed")).toThrow(
      DomainTransitionError,
    );
  });

  it("leases, drains, and permanently terminates a sandbox", () => {
    expect(transitionSandbox("provisioning", "ready")).toBe("ready");
    expect(transitionSandbox("ready", "leased")).toBe("leased");
    expect(transitionSandbox("leased", "ready")).toBe("ready");
    expect(transitionSandbox("ready", "draining")).toBe("draining");
    expect(isTerminalSandboxState(transitionSandbox("draining", "terminated"))).toBe(true);
    expect(() => transitionSandbox("terminated", "ready")).toThrow(DomainTransitionError);
  });

  it("allows failed sandbox cleanup without allowing reuse", () => {
    expect(transitionSandbox("leased", "failed")).toBe("failed");
    expect(transitionSandbox("failed", "terminated")).toBe("terminated");
    expect(() => transitionSandbox("failed", "ready")).toThrow(DomainTransitionError);
  });

  it("rejects self-transitions so duplicate delivery is handled by idempotency", () => {
    expect(() => transitionSession("idle", "idle")).toThrow(DomainTransitionError);
    expect(() => transitionTurn("running", "running")).toThrow(DomainTransitionError);
  });
});
