import { RunStateSchema, SessionStateSchema } from "@pi-cloud/protocol";
import { Type, type Static } from "typebox";

export type SessionState = Static<typeof SessionStateSchema>;

export const TurnStateSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("cancelling"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export const SandboxStateSchema = Type.Union([
  Type.Literal("provisioning"),
  Type.Literal("ready"),
  Type.Literal("draining"),
  Type.Literal("failed"),
  Type.Literal("terminated"),
]);

export const TurnControlRequestStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("dispatched"),
  Type.Literal("acknowledged"),
  Type.Literal("completed"),
  Type.Literal("failed"),
]);

export { RunStateSchema } from "@pi-cloud/protocol";

export type TurnState = Static<typeof TurnStateSchema>;
export type SandboxState = Static<typeof SandboxStateSchema>;
export type TurnControlRequestState = Static<typeof TurnControlRequestStateSchema>;
export type RunState = Static<typeof RunStateSchema>;

/** Public conversation status is derived from the sole stored Run lifecycle. */
export function turnStateForRun(state: RunState): TurnState {
  if (state === "cancel_requested") return "cancelling";
  if (state === "timed_out") return "failed";
  if (state === "settling") return "running";
  return state;
}

export type DomainEntityKind = "session" | "sandbox" | "control_request" | "run";

type TransitionTable<State extends string> = Readonly<Record<State, readonly State[]>>;

// Admission is atomic; recovery's exit/seal proof is enforced by its PG owner.
const sessionTransitions = {
  cold: ["running"],
  idle: ["running", "failed"],
  running: ["idle", "cancelling", "failed"],
  cancelling: ["idle", "failed"],
  failed: ["idle"],
} as const satisfies TransitionTable<SessionState>;

const sandboxTransitions = {
  provisioning: ["ready", "failed", "terminated"],
  ready: ["draining", "failed"],
  draining: ["terminated", "failed"],
  failed: ["terminated"],
  terminated: [],
} as const satisfies TransitionTable<SandboxState>;

const controlRequestTransitions = {
  pending: ["dispatched", "failed"],
  dispatched: ["pending", "acknowledged", "failed"],
  acknowledged: ["completed", "failed"],
  completed: [],
  failed: [],
} as const satisfies TransitionTable<TurnControlRequestState>;

const runTransitions = {
  queued: ["running", "cancel_requested", "failed", "cancelled"],
  running: ["queued", "settling", "cancel_requested", "completed", "failed", "timed_out"],
  settling: ["queued", "cancel_requested", "completed", "failed", "timed_out"],
  cancel_requested: ["queued", "cancelled", "failed", "timed_out"],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
} as const satisfies TransitionTable<RunState>;

export class DomainTransitionError extends Error {
  readonly entityKind: DomainEntityKind;
  readonly from: string;
  readonly to: string;

  constructor(entityKind: DomainEntityKind, from: string, to: string) {
    super(`Invalid ${entityKind} transition: ${from} -> ${to}`);
    this.name = "DomainTransitionError";
    this.entityKind = entityKind;
    this.from = from;
    this.to = to;
  }
}

function canTransition<State extends string>(
  table: TransitionTable<State>,
  from: State,
  to: State,
): boolean {
  return table[from].some((candidate) => candidate === to);
}

function transition<State extends string>(
  entityKind: DomainEntityKind,
  table: TransitionTable<State>,
  from: State,
  to: State,
): State {
  if (!canTransition(table, from, to)) {
    throw new DomainTransitionError(entityKind, from, to);
  }
  return to;
}

export function transitionSession(from: SessionState, to: SessionState): SessionState {
  return transition("session", sessionTransitions, from, to);
}

export function transitionSandbox(from: SandboxState, to: SandboxState): SandboxState {
  return transition("sandbox", sandboxTransitions, from, to);
}

export function transitionTurnControlRequest(
  from: TurnControlRequestState,
  to: TurnControlRequestState,
): TurnControlRequestState {
  return transition("control_request", controlRequestTransitions, from, to);
}

export function transitionRun(from: RunState, to: RunState): RunState {
  return transition("run", runTransitions, from, to);
}

export function isTerminalRunState(state: RunState): boolean {
  return (
    state === "completed" || state === "failed" || state === "cancelled" || state === "timed_out"
  );
}
