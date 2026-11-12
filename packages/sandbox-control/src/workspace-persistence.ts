import {
  validatedIdentity,
  validatedVolumeIdentity,
  WorkspaceVolumeGatewayError,
  type WorkspaceVolumeGatewayIdentity,
  type WorkspaceVolumeGatewayVolumeIdentity,
} from "./workspace-volume-gateway-contract.ts";

export type WorkspacePersistenceCapabilities = Readonly<{
  kind: "independent-volume" | "retained-sandbox" | "temporary";
  computeRelease: "destroy" | "stop" | "pause";
  shared: boolean;
  newSandbox: boolean;
}>;
export type WorkspaceVolumeReference = Readonly<{
  kind: "volume";
  volumeId: string;
  generation: string;
  poolId: string;
}>;
export type WorkspacePersistenceReference =
  | WorkspaceVolumeReference
  | Readonly<{
      kind: "sandbox";
      backendId: string;
      sandboxId: string;
    }>;
export type WorkspacePersistenceState = Readonly<{
  state: "uninitialized" | "initializing" | "ready" | "unavailable" | "deleted";
  reference?: WorkspacePersistenceReference;
}>;

/** Workspace retention is independent of a provider's native Volume API. */
export interface WorkspacePersistence {
  readonly capabilities: WorkspacePersistenceCapabilities;
  ensure(input: WorkspaceVolumeGatewayIdentity): Promise<WorkspacePersistenceReference>;
  inspect(input: WorkspaceVolumeGatewayVolumeIdentity): Promise<WorkspacePersistenceState>;
  prepareDelete(input: WorkspaceVolumeGatewayVolumeIdentity): Promise<{ prepared: boolean }>;
  finalizeDelete(input: WorkspaceVolumeGatewayVolumeIdentity): Promise<{ deleted: boolean }>;
}

export const LOCAL_WORKSPACE_PERSISTENCE = Object.freeze({
  kind: "independent-volume",
  computeRelease: "destroy",
  shared: true,
  newSandbox: true,
} as const);
export const WORKSPACE_PERSISTENCE_PATH = "/v1/workspace-storage";

export function requireRetainedWorkspace(
  capability: WorkspacePersistenceCapabilities,
  shared = false,
) {
  if (
    capability.kind === "temporary" ||
    (capability.kind === "retained-sandbox" && capability.computeRelease === "destroy")
  )
    throw new Error("Backend cannot retain this Workspace when compute is released");
  if (shared && !capability.shared) throw new Error("Backend does not support a shared Workspace");
  return capability.computeRelease;
}

export function workspaceVolumeReference(
  value: WorkspacePersistenceReference,
): WorkspaceVolumeReference {
  if (value.kind !== "volume") throw new Error("This native mount requires an independent volume");
  if (
    !/^pcw-[a-f0-9]{48}$/.test(value.volumeId) ||
    !/^[a-f0-9]{64}$/.test(value.generation) ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.poolId)
  )
    throw new Error("Invalid Workspace storage reference");
  return value;
}

/** Uses the existing authenticated Gateway transport; no new connection layer. */
export function workspacePersistenceClient(
  request: (path: string, body: unknown) => Promise<unknown>,
): WorkspacePersistence {
  const ready = new Map<string, WorkspaceVolumeReference>();
  const key = (input: WorkspaceVolumeGatewayVolumeIdentity) =>
    `${input.tenantId}:${input.workspaceId}`;
  return {
    capabilities: LOCAL_WORKSPACE_PERSISTENCE,
    async ensure(input) {
      validatedIdentity(input);
      const cached = ready.get(key(input));
      if (cached) return cached;
      const result = workspaceVolumeReference(
        (await request(WORKSPACE_PERSISTENCE_PATH + "/ensure", input)) as WorkspaceVolumeReference,
      );
      if (result.volumeId !== input.volumeId) throw new Error("Workspace storage identity changed");
      if (ready.size >= 4096) ready.delete(ready.keys().next().value!);
      ready.set(key(input), result);
      return result;
    },
    async inspect(input) {
      validatedVolumeIdentity(input);
      const result = (await request(
        WORKSPACE_PERSISTENCE_PATH + "/inspect",
        input,
      )) as WorkspacePersistenceState;
      if (
        !result ||
        !["uninitialized", "initializing", "ready", "unavailable", "deleted"].includes(result.state)
      )
        throw new Error("Invalid Workspace persistence state");
      if (
        result.reference &&
        workspaceVolumeReference(result.reference).volumeId !== input.volumeId
      )
        throw new Error("Workspace storage identity changed");
      return result;
    },
    async prepareDelete(input) {
      validatedVolumeIdentity(input);
      ready.delete(key(input));
      const result = (await request(WORKSPACE_PERSISTENCE_PATH + "/prepare-delete", input)) as {
        prepared?: boolean;
      };
      if (result?.prepared !== true)
        throw new WorkspaceVolumeGatewayError(
          "workspace_storage_unconfirmed",
          "Workspace deletion admission is unconfirmed",
          true,
        );
      return { prepared: true };
    },
    async finalizeDelete(input) {
      validatedVolumeIdentity(input);
      ready.delete(key(input));
      const result = (await request(WORKSPACE_PERSISTENCE_PATH + "/finalize-delete", input)) as {
        deleted?: boolean;
      };
      if (result?.deleted !== true)
        throw new WorkspaceVolumeGatewayError(
          "workspace_storage_unconfirmed",
          "Workspace deletion is unconfirmed",
          true,
        );
      return { deleted: true };
    },
  };
}
