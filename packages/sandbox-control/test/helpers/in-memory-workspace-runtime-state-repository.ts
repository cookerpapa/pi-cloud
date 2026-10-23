import type {
  DevelopmentEnvironmentState,
  SandboxControlWorkspaceRuntimeState,
  WorkspaceTerminalState,
} from "@pi-cloud/database";
import {
  createExecutionReference,
  parseExecutionReference,
  type ToolSandboxAssignment,
  type SandboxPreviewTarget,
} from "@pi-cloud/protocol";
import {
  SANDBOX_CREATION_WINDOW_MS,
  type SandboxHandle,
  type SandboxCreateSpec,
  type SandboxAllocationAuthorization,
} from "../../src/sandbox-provider.ts";
import { isDeepStrictEqual } from "node:util";
import type {
  WorkspaceRuntimeStateRepository,
  OrphanedWorkspaceTerminal,
  WorkspaceRuntimeReservation,
  DevelopmentEnvironmentReservation,
  WorkspaceRuntimeReservationResult,
  WorkspaceTerminalReservation,
  WorkspaceTerminalReservationResult,
  DevelopmentEnvironmentReservationResult,
  DevelopmentEnvironmentOwnerResult,
  SandboxPreviewOwnerResult,
  RecoverableDevelopmentEnvironment,
  OrphanedWorkspaceRuntime,
  AllocationKind,
  AllocationClosure,
} from "../../src/workspace-runtime-state-repository.ts";

/** Test fixture only. Production effects always use PostgreSQL ownership. */
export class InMemoryWorkspaceRuntimeStateRepository implements WorkspaceRuntimeStateRepository {
  async reconcileOwnership(): Promise<void> {}
  readonly creations = new Map<
    string,
    { spec: SandboxCreateSpec; authorization: SandboxAllocationAuthorization }
  >();
  readonly closedAllocations = new Set<string>();
  async beginCreation(
    spec: SandboxCreateSpec,
    _kind?: AllocationKind,
  ): Promise<SandboxAllocationAuthorization> {
    if (this.closedAllocations.has(spec.activationId)) throw new Error("Allocation closed");
    const prior = this.creations.get(spec.activationId);
    if (prior) {
      if (!isDeepStrictEqual(prior.spec, spec)) throw new Error("Allocation changed");
      return prior.authorization;
    }
    const authorization = { createBefore: Date.now() + SANDBOX_CREATION_WINDOW_MS };
    this.creations.set(spec.activationId, { spec: structuredClone(spec), authorization });
    return authorization;
  }
  async closeAllocation(id: string, _kind: AllocationKind): Promise<AllocationClosure> {
    this.closedAllocations.add(id);
    this.onQuarantine?.(id);
    const prior = this.creations.get(id);
    return prior
      ? { status: "authorized", authorization: prior.authorization }
      : { status: "never_issued" };
  }
  onQuarantine?: (physicalActivationId: string) => void;
  readonly #terminals = new Map<string, OrphanedWorkspaceTerminal>();
  readonly #activations = new Map<string, WorkspaceRuntimeReservation>();
  readonly #runtimeStates = new Map<string, SandboxControlWorkspaceRuntimeState>();
  readonly #developmentEnvironments = new Map<
    string,
    { reservation: DevelopmentEnvironmentReservation; state: DevelopmentEnvironmentState }
  >();

  async start(): Promise<void> {}
  async claimRecoverableWorkspaceRuntimes(
    _limit: number,
    _excluded: readonly string[] = [],
  ): Promise<
    readonly import("../../src/workspace-runtime-state-repository.ts").RecoverableWorkspaceRuntime[]
  > {
    return [];
  }
  async registerToolBinding(
    _bindingId: string,
    _assignment: ToolSandboxAssignment,
  ): Promise<void> {}
  async checkHealth(): Promise<void> {}
  assertLocalOwnership(): void {}
  async reserve(input: WorkspaceRuntimeReservation): Promise<WorkspaceRuntimeReservationResult> {
    if (
      input.computeSessionId === undefined &&
      [...this.#developmentEnvironments.values()].some(
        ({ reservation: environment, state }) =>
          environment.tenantId === input.assignment.tenantId &&
          environment.workspaceId === input.assignment.workspaceId &&
          (environment.allocationId !== input.activationId ||
            state !== "ready" ||
            environment.desiredState !== "running"),
      )
    ) {
      return { status: "busy" };
    }
    this.#activations.set(input.activationId, input);
    this.#runtimeStates.set(input.activationId, "reserved");
    const development = [...this.#developmentEnvironments.values()].find(
      (e) => e.reservation.allocationId === input.activationId,
    );
    return development === undefined
      ? { status: "reserved" }
      : { status: "development_environment", environmentId: development.reservation.environmentId };
  }
  async returnDevelopmentEnvironment(environmentId: string, activationId: string): Promise<void> {
    const environment = this.#developmentEnvironments.get(environmentId);
    if (environment?.reservation.allocationId !== activationId) return;
    this.#activations.delete(activationId);
  }
  async reserveDevelopmentEnvironmentTerminal(
    environmentId: string,
    allocationId: string,
  ): Promise<boolean> {
    const environment = this.#developmentEnvironments.get(environmentId);
    return (
      environment !== undefined &&
      environment.reservation.allocationId === allocationId &&
      environment.state === "ready" &&
      environment.reservation.desiredState === "running"
    );
  }
  async releaseDevelopmentEnvironmentTerminal(_environmentId: string): Promise<void> {}
  async reserveTerminal(
    input: WorkspaceTerminalReservation,
  ): Promise<WorkspaceTerminalReservationResult> {
    if (
      [...this.#terminals.values()].some(
        (terminal) =>
          terminal.tenantId === input.tenantId && terminal.workspaceId === input.workspaceId,
      ) ||
      [...this.#developmentEnvironments.values()].some(
        ({ reservation: environment }) =>
          environment.tenantId === input.tenantId && environment.workspaceId === input.workspaceId,
      )
    ) {
      return { status: "busy" };
    }
    const generation =
      Math.max(
        0,
        ...[...this.#activations.values()]
          .filter(
            (activation) =>
              activation.assignment.tenantId === input.tenantId &&
              activation.assignment.workspaceId === input.workspaceId,
          )
          .map(
            (activation) =>
              parseExecutionReference(activation.assignment.executionReference).fencingToken,
          ),
      ) + 1;
    const currentActivation = [...this.#activations.values()].find(
      (activation) =>
        activation.computeSessionId === undefined &&
        activation.assignment.tenantId === input.tenantId &&
        activation.assignment.workspaceId === input.workspaceId,
    );
    const executionId =
      currentActivation === undefined
        ? input.terminalId
        : parseExecutionReference(currentActivation.assignment.executionReference).runId;
    const executionReference = createExecutionReference(input.terminalId, executionId, generation);
    this.#terminals.set(input.terminalId, { ...input, fencingToken: generation });
    return {
      status: "reserved",
      executionReference,
      ...(currentActivation === undefined
        ? {}
        : { workspaceRuntimeId: currentActivation.activationId }),
    };
  }
  async reserveDevelopmentEnvironment(
    input: DevelopmentEnvironmentReservation,
  ): Promise<DevelopmentEnvironmentReservationResult> {
    if (
      [...this.#activations.values()].some(
        (activation) =>
          activation.computeSessionId === undefined &&
          activation.assignment.tenantId === input.tenantId &&
          activation.assignment.workspaceId === input.workspaceId,
      ) ||
      [...this.#terminals.values()].some(
        (terminal) =>
          terminal.tenantId === input.tenantId && terminal.workspaceId === input.workspaceId,
      ) ||
      [...this.#developmentEnvironments.values()].some(
        ({ reservation: environment }) =>
          environment.tenantId === input.tenantId &&
          environment.workspaceId === input.workspaceId &&
          environment.environmentId !== input.environmentId,
      )
    ) {
      return { status: "busy" };
    }
    this.#developmentEnvironments.set(input.environmentId, {
      reservation: input,
      state: "ready",
    });
    return { status: "reserved" };
  }
  async developmentEnvironmentOwner(
    _tenantId: string,
    _userId: string,
    environmentId: string,
  ): Promise<DevelopmentEnvironmentOwnerResult> {
    const environment = this.#developmentEnvironments.get(environmentId);
    return environment === undefined
      ? { status: "unavailable" }
      : {
          status: "owned",
          state: environment.state,
          reservation: environment.reservation,
          agentActive: false,
          terminalActive: false,
        };
  }
  async sandboxPreviewOwner(
    _tenantId: string,
    _userId: string,
    target: SandboxPreviewTarget,
  ): Promise<SandboxPreviewOwnerResult> {
    if (target.kind === "development_environment") {
      return this.#developmentEnvironments.has(target.environmentId)
        ? { status: "owned" }
        : { status: "unavailable" };
    }
    return [...this.#activations.values()].some(
      (activation) => activation.assignment.sessionId === target.sessionId,
    )
      ? { status: "owned" }
      : { status: "unavailable" };
  }
  async setDevelopmentEnvironmentState(
    identity: Pick<
      DevelopmentEnvironmentReservation,
      "environmentId" | "allocationId" | "intentRevision"
    >,
    state: Exclude<DevelopmentEnvironmentState, "requested">,
  ): Promise<void> {
    const environmentId = identity.environmentId;
    if (state === "reconciling") this.onQuarantine?.(identity.allocationId);
    const environment = this.#developmentEnvironments.get(environmentId);
    if (state === "released") {
      this.#developmentEnvironments.delete(environmentId);
    } else if (environment !== undefined) {
      environment.state = state;
    }
  }
  async claimRecoverableDevelopmentEnvironments(
    _limit: number,
    excluded: readonly string[] = [],
  ): Promise<readonly RecoverableDevelopmentEnvironment[]> {
    return [...this.#developmentEnvironments.values()]
      .filter((e) => !excluded.includes(e.reservation.environmentId) || e.state !== "ready")
      .map((e) => ({
        ...e,
        allocationAbsent: false,
        ...(this.creations.has(e.reservation.allocationId)
          ? { creation: this.creations.get(e.reservation.allocationId)! }
          : {}),
      }));
  }
  async confirmDevelopmentEnvironmentAbsent(
    identity: DevelopmentEnvironmentReservation,
  ): Promise<void> {
    this.closedAllocations.add(identity.allocationId);
  }
  async prepareDevelopmentEnvironmentImage(
    identity: DevelopmentEnvironmentReservation,
    imageRevision: string,
  ) {
    const spec = this.creations.get(identity.allocationId)!.spec;
    return { ...spec.environment, imageRevision };
  }
  async replaceDevelopmentEnvironmentAllocation(
    identity: DevelopmentEnvironmentReservation,
    spec: SandboxCreateSpec,
  ): Promise<DevelopmentEnvironmentReservation> {
    if (!this.closedAllocations.has(identity.allocationId))
      throw new Error("Old allocation must be closed");
    const next = {
      ...identity,
      allocationId: spec.activationId,
      generation: identity.generation + 1,
      allocationClosed: false,
    };
    this.#developmentEnvironments.set(identity.environmentId, {
      reservation: next,
      state: "provisioning",
    });
    await this.beginCreation(spec);
    return next;
  }
  setMachineIntent(id: string, desiredState: "running" | "paused" | "released"): number {
    const machine = this.#developmentEnvironments.get(id)!;
    machine.reservation = {
      ...machine.reservation,
      desiredState,
      intentRevision: machine.reservation.intentRevision + 1,
    };
    machine.state = "reconciling";
    return machine.reservation.intentRevision;
  }
  async setTerminalState(terminalId: string, state: WorkspaceTerminalState): Promise<void> {
    if (state === "released") this.#terminals.delete(terminalId);
  }
  async claimOrphanedTerminals(): Promise<readonly OrphanedWorkspaceTerminal[]> {
    return [];
  }
  async setWorkspaceRuntimeState(
    activationId: string,
    state: SandboxControlWorkspaceRuntimeState,
    _detail?: { handle?: SandboxHandle; failureCode?: string },
  ): Promise<void> {
    this.#runtimeStates.set(activationId, state);
    if (state === "unknown") this.onQuarantine?.(activationId);
    if (state === "released") this.#activations.delete(activationId);
  }
  async claimWarmRuntimeRetirement(activationId: string): Promise<boolean> {
    const runtime = this.#activations.get(activationId);
    if (!runtime || this.#runtimeStates.get(activationId) !== "allocated") return false;
    if (
      runtime.computeSessionId === undefined &&
      [...this.#terminals.values()].some(
        (terminal) =>
          terminal.tenantId === runtime.assignment.tenantId &&
          terminal.workspaceId === runtime.assignment.workspaceId,
      )
    )
      return false;
    this.#runtimeStates.set(activationId, "cleaning");
    return true;
  }
  async claimOrphanedWorkspaceRuntimes(): Promise<readonly OrphanedWorkspaceRuntime[]> {
    return [];
  }
  async claimUnboundWorkspaceRuntimes(): Promise<readonly OrphanedWorkspaceRuntime[]> {
    return [];
  }
  async listRetiredWarmWorkspaceRuntimeIds(): Promise<readonly string[]> {
    return [];
  }
  async close(): Promise<void> {}
}
