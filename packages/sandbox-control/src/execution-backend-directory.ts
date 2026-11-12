import { operationalLog } from "@pi-cloud/observability";
import { isDeepStrictEqual } from "node:util";
import type { Kysely } from "kysely";
import { PostgresNotificationWake, type Database } from "@pi-cloud/database";
import { CubePersistentCapsuleCodec } from "./cube-persistent-capsule.ts";
import {
  backendEndpoint,
  readResourceBackends,
  type ResourceBackend,
} from "./resource-backend-registry.ts";
import { createResourceBackendTransport } from "./resource-backend-transport.ts";
import type { SandboxRuntimeTransportConfig } from "./sandbox-control-config.ts";
import type { SandboxExecutionDescriptor, SandboxExecutionTarget } from "./sandbox-execution.ts";
import { GuestExecutionRejected, type GuestRuntimeClient } from "./guest-runtime-client.ts";
import type { FixedGuestSandboxProvider } from "./fixed-guest-sandbox-provider.ts";
import type { SandboxHandle } from "./sandbox-provider.ts";

type Transport = Awaited<ReturnType<typeof createResourceBackendTransport>>;
type Entry = { backend: ResourceBackend; transport: Transport };
const endpointKey = (url: string) => new URL(url).toString().replace(/\/$/, "");

/** Warm bound dispatch is a lookup by immutable native endpoint. Cold registry
 * reconciliation never observes Worker ownership and never creates a sandbox. */
export async function createExecutionBackendDirectory(options: {
  database: Kysely<Database>;
  config: Pick<
    SandboxRuntimeTransportConfig,
    "persistentStateKey" | "imageRevision" | "serviceToken"
  >;
  notificationUrl: string;
}) {
  const { database, config } = options;
  const codec = new CubePersistentCapsuleCodec(config.persistentStateKey);
  const byId = new Map<string, Entry>(),
    byEndpoint = new Map<string, Entry>();
  const handles = new WeakMap<SandboxHandle, FixedGuestSandboxProvider>();
  const abort = new AbortController();
  const wake = new PostgresNotificationWake(options.notificationUrl, "pi_cloud_resource_backends");
  let refreshing: Promise<void> | undefined;
  const refresh = () =>
    (refreshing ??= (async () => {
      for (const backend of await readResourceBackends(database, codec)) {
        if (abort.signal.aborted) return;
        const previous = byId.get(backend.resource.id);
        if (previous?.backend.resource.revision === backend.resource.revision) continue;
        const connection = ({ templates: _, ...rest }: ResourceBackend["configuration"]) => rest;
        if (
          previous &&
          isDeepStrictEqual(
            connection(previous.backend.configuration),
            connection(backend.configuration),
          )
        ) {
          previous.backend = backend;
          continue;
        }
        try {
          const transport = await createResourceBackendTransport(
            database,
            config,
            backend,
            "execution",
          );
          const entry = { backend, transport };
          if (previous) {
            byEndpoint.delete(endpointKey(backendEndpoint(previous.backend.configuration)));
            await previous.transport.provider.close();
          }
          byId.set(backend.resource.id, entry);
          byEndpoint.set(endpointKey(backendEndpoint(backend.configuration)), entry);
        } catch {
          operationalLog({
            service: "pi-cloud-session-runtime",
            level: "warn",
            event: "resource_backend.transport_unavailable",
            attributes: { backendId: backend.resource.id },
          });
        }
      }
    })().finally(() => {
      refreshing = undefined;
    }));
  async function target(value: SandboxExecutionTarget) {
    if (abort.signal.aborted) throw new GuestExecutionRejected("execution_unavailable");
    const key = endpointKey(value.apiUrl);
    let entry = byEndpoint.get(key);
    if (!entry) {
      await refresh();
      entry = byEndpoint.get(key);
    }
    if (!entry) throw new GuestExecutionRejected("execution_endpoint_unconfigured");
    return entry.transport;
  }
  async function workspace(input: { tenantId: string; workspaceId: string }) {
    const row = await database
      .selectFrom("workspaces")
      .select("sandbox_domain_id")
      .where("tenant_id", "=", input.tenantId)
      .where("id", "=", input.workspaceId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) throw new Error("Workspace is unavailable");
    if (!byId.has(row.sandbox_domain_id)) await refresh();
    const entry = byId.get(row.sandbox_domain_id);
    if (!entry) throw new Error("Workspace backend is unavailable");
    return entry.transport.provider;
  }
  const forHandle = (handle: SandboxHandle) => {
    const provider = handles.get(handle);
    if (!provider || abort.signal.aborted) throw new Error("Execution data handle is unavailable");
    return provider;
  };
  type HandleMethod =
    | "openWorkflow"
    | "preparePackage"
    | "exportPackage"
    | "imageIo"
    | "prepareInputImage"
    | "discoverHttpServices"
    | "listMachineWorkspaceDirectory"
    | "readMachineWorkspaceFile"
    | "openPreviewConnection";
  function route<K extends HandleMethod>(method: K): FixedGuestSandboxProvider[K] {
    return ((handle: SandboxHandle, ...args: unknown[]) => {
      const provider = forHandle(handle);
      return (provider[method] as (...args: unknown[]) => unknown).call(provider, handle, ...args);
    }) as FixedGuestSandboxProvider[K];
  }
  const provider = {
    providerId: "managed",
    async attachExecutionData(descriptor: SandboxExecutionDescriptor) {
      const actual = (await target(descriptor.target)).provider;
      const handle = actual.attachExecutionData(descriptor);
      handles.set(handle, actual);
      return handle;
    },
    async openDataCapsule(capsule: string) {
      const raw = codec.open(capsule) as { executionTarget: SandboxExecutionTarget };
      if (!raw.executionTarget) throw new Error("Resource data target is missing");
      const actual = (await target(raw.executionTarget)).provider;
      const handle = actual.openDataCapsule(capsule);
      handles.set(handle, actual);
      return handle;
    },
    openWorkflow: route("openWorkflow"),
    preparePackage: route("preparePackage"),
    exportPackage: route("exportPackage"),
    imageIo: route("imageIo"),
    prepareInputImage: route("prepareInputImage"),
    discoverHttpServices: route("discoverHttpServices"),
    listMachineWorkspaceDirectory: route("listMachineWorkspaceDirectory"),
    readMachineWorkspaceFile: route("readMachineWorkspaceFile"),
    openPreviewConnection: route("openPreviewConnection"),
    listWorkspaceDirectory: async (
      ...args: Parameters<FixedGuestSandboxProvider["listWorkspaceDirectory"]>
    ) => (await workspace(args[0])).listWorkspaceDirectory(...args),
    readWorkspaceFile: async (
      ...args: Parameters<FixedGuestSandboxProvider["readWorkspaceFile"]>
    ) => (await workspace(args[0])).readWorkspaceFile(...args),
    clearExecutionData() {
      for (const entry of byId.values()) entry.transport.provider.clearExecutionData();
    },
  };
  const client: Pick<
    GuestRuntimeClient,
    "submitTool" | "cancelTool" | "submitProbe" | "probeExecution"
  > = {
    submitTool: async (t, request) => (await target(t)).client.submitTool(t, request),
    cancelTool: async (t, request) => (await target(t)).client.cancelTool(t, request),
    submitProbe: async (t, request) => (await target(t)).client.submitProbe(t, request),
    probeExecution: async (t, id) => (await target(t)).client.probeExecution(t, id),
  };
  try {
    await refresh();
  } catch (error) {
    await Promise.allSettled([
      wake.close(),
      ...[...byId.values()].map((e) => e.transport.provider.close()),
    ]);
    throw error;
  }
  const watching = (async () => {
    while (!abort.signal.aborted) {
      wake.refresh();
      const generation = wake.generation;
      await refresh().catch(() => {});
      await wake.wait(generation, 15_000, abort.signal);
    }
  })();
  return {
    provider,
    client,
    refresh,
    async close() {
      abort.abort();
      await watching;
      await refreshing;
      const results = await Promise.allSettled([
        wake.close(),
        ...[...byId.values()].map((e) => e.transport.provider.close()),
      ]);
      const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
      if (errors.length) throw new AggregateError(errors, "Execution backend cleanup failed");
    },
  };
}
