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
import type { SandboxHandle } from "../../src/sandbox-provider.ts";
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
} from "../../src/workspace-runtime-state-repository.ts";

/** Test fixture only. Production effects always use PostgreSQL ownership. */
export class InMemoryWorkspaceRuntimeStateRepository implements WorkspaceRuntimeStateRepository {
  readonly #terminals = new Map<string, OrphanedWorkspaceTerminal>();
  readonly #activations = new Map<string, WorkspaceRuntimeReservation>();
  readonly #developmentEnvironments = new Map<
    string,
    { reservation: DevelopmentEnvironmentReservation; state: DevelopmentEnvironmentState }
  >();

  async start(): Promise<void> {}
  async claimRecoverableWorkspaceRuntimes(): Promise<
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
          (environment.environmentId !== input.activationId || state !== "running"),
      )
    ) {
      return { status: "busy" };
    }
    this.#activations.set(input.activationId, input);
    const development = this.#developmentEnvironments.get(input.activationId);
    return development === undefined
      ? { status: "reserved" }
      : { status: "development_environment", environmentId: input.activationId };
  }
  async returnDevelopmentEnvironment(
    environmentId: string,
    activationId: string,
    outcome: "running" | "unknown",
  ): Promise<void> {
    if (environmentId !== activationId) return;
    const environment = this.#developmentEnvironments.get(environmentId);
    if (environment !== undefined) environment.state = outcome;
    this.#activations.delete(activationId);
  }
  async reserveDevelopmentEnvironmentTerminal(environmentId: string): Promise<boolean> {
    const environment = this.#developmentEnvironments.get(environmentId);
    return environment !== undefined && environment.state === "running";
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
      state: "running",
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
    environmentId: string,
    state: Exclude<DevelopmentEnvironmentState, "requested">,
  ): Promise<void> {
    const environment = this.#developmentEnvironments.get(environmentId);
    if (state === "released" || state === "failed") {
      this.#developmentEnvironments.delete(environmentId);
    } else if (environment !== undefined) {
      environment.state = state;
    }
  }
  async claimRecoverableDevelopmentEnvironments(): Promise<
    readonly RecoverableDevelopmentEnvironment[]
  > {
    return [];
  }
  async claimOrphanedDevelopmentEnvironments(): Promise<
    readonly DevelopmentEnvironmentReservation[]
  > {
    return [];
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
    if (state === "released") this.#activations.delete(activationId);
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
