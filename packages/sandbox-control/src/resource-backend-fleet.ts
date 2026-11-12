import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PostgresNotificationWake } from "@pi-cloud/database";
import type { ResourceBackendConfiguration } from "@pi-cloud/protocol";
import { createSandboxControl } from "./sandbox-control-runtime.ts";
import { loadSandboxControlConfig } from "./sandbox-control-config.ts";
import { SandboxControlServer, type SandboxControlBackend } from "./sandbox-control-server.ts";
import { ResourceBackendRegistry, type ResourceBackend } from "./resource-backend-registry.ts";
import {
  createResourceBackendTransport,
  verifyResourceBackend,
} from "./resource-backend-transport.ts";
import { HttpWorkspaceVolumeGateway } from "./workspace-volume-gateway.ts";
import { SandboxControlError } from "./sandbox-provider.ts";
import type { SandboxController } from "./sandbox-controller.ts";

type Runtime = Awaited<ReturnType<typeof createSandboxControl>>;
type Entry = { backend: ResourceBackend; runtime: Runtime };
type Options = Parameters<typeof createSandboxControl>[0];

/** Existing domain controllers share one listener. Registering a backend starts
 * no new process and gives neither execution nor public API lifecycle authority. */
export async function createResourceBackendFleet(options: Options) {
  const config = options.config ?? (await loadSandboxControlConfig());
  const database = options.database;
  const registry = new ResourceBackendRegistry({
    database,
    key: config.persistentStateKey,
    managementBaseUrl: config.managementBaseUrl,
    verify: (input) => verifyResourceBackend(database, config, input),
  });
  const entries = new Map<string, Entry>();
  const abort = new AbortController();
  const wake = new PostgresNotificationWake(
    config.databaseNotificationUrl,
    "pi_cloud_resource_backends",
  );
  let reconciling: Promise<void> | undefined,
    watching: Promise<void> | undefined,
    started = false;
  let closing: Promise<void> | undefined;
  const refresh = () =>
    (reconciling ??= (async () => {
      for (const backend of await registry.list()) {
        if (abort.signal.aborted) return;
        const id = backend.resource.id;
        const old = entries.get(id);
        if (old && old.backend.resource.revision === backend.resource.revision && old.runtime.ready)
          continue;
        const connection = ({ templates: _, ...rest }: ResourceBackendConfiguration) => rest;
        if (
          old?.runtime.ready &&
          isDeepStrictEqual(
            connection(old.backend.configuration),
            connection(backend.configuration),
          )
        ) {
          old.backend = backend; // Name/state/template additions do not replace controllers.
          continue;
        }
        if (old) {
          entries.delete(id);
          await old.runtime.close();
        }
        let entry: Entry | undefined;
        try {
          const runtime = await createSandboxControl({
            ...options,
            instanceId: randomUUID(),
            listen: false,
            config: { ...config, sandboxDomainId: id },
            backendRevision: () => entry?.backend.resource.revision ?? backend.resource.revision,
            transportFactory: () =>
              createResourceBackendTransport(
                database,
                config,
                backend,
                "management",
                () => entry?.backend ?? backend,
              ),
            onOwnershipLost: () => {
              wake.refresh();
            },
          });
          entry = { backend, runtime };
          entries.set(id, entry);
          await runtime.start();
        } catch {
          // A failed backend stays unavailable. Other domain owners keep serving.
          if (entry) {
            entries.delete(id);
            await entry.runtime.close();
          }
        }
      }
    })().finally(() => {
      reconciling = undefined;
    }));

  async function controller(input: unknown, second?: unknown): Promise<SandboxController> {
    const value = (typeof input === "object" && input !== null ? input : second) as
      | {
          assignment?: unknown;
          workspaceId?: string;
          tenantId?: string;
          environmentId?: string;
        }
      | undefined;
    const identity = (value?.assignment ?? value) as typeof value;
    let domainId: string | undefined;
    if (identity?.workspaceId) {
      let query = database
        .selectFrom("workspaces")
        .select("sandbox_domain_id")
        .where("id", "=", identity.workspaceId);
      if (identity.tenantId) query = query.where("tenant_id", "=", identity.tenantId);
      domainId = (await query.executeTakeFirst())?.sandbox_domain_id;
    } else if (identity?.environmentId) {
      let query = database
        .selectFrom("development_environments")
        .select("sandbox_domain_id")
        .where("id", "=", identity.environmentId);
      if (identity.tenantId) query = query.where("tenant_id", "=", identity.tenantId);
      domainId = (await query.executeTakeFirst())?.sandbox_domain_id;
    }
    if (!domainId)
      throw new SandboxControlError(
        "resource_backend_unavailable",
        "Resource backend is unavailable",
        true,
      );
    let entry = entries.get(domainId);
    if (!entry?.runtime.ready) {
      await refresh();
      entry = entries.get(domainId);
    }
    if (!entry?.runtime.ready)
      throw new SandboxControlError(
        "resource_backend_unavailable",
        "Resource backend is not ready",
        true,
      );
    return entry.runtime.controller;
  }
  type AsyncMethod = {
    [K in keyof SandboxController]: SandboxController[K] extends (
      ...args: never[]
    ) => Promise<unknown>
      ? K
      : never;
  }[keyof SandboxController];
  function route<K extends AsyncMethod>(method: K): SandboxController[K] {
    return (async (...args: unknown[]) => {
      const target = await controller(args[0], args[1]);
      return (target[method] as (...args: unknown[]) => Promise<unknown>).apply(target, args);
    }) as SandboxController[K];
  }
  const backend: SandboxControlBackend = {
    providerId: "managed",
    get activeCount() {
      return [...entries.values()].reduce((n, e) => n + e.runtime.controller.activeCount, 0);
    },
    get admittedCount() {
      return [...entries.values()].reduce((n, e) => n + e.runtime.controller.admittedCount, 0);
    },
    get admissionWaitingCount() {
      return [...entries.values()].reduce(
        (n, e) => n + e.runtime.controller.admissionWaitingCount,
        0,
      );
    },
    maximumActiveSandboxes: null,
    cleanPrewarmCount: 0,
    checkHealth: async () => {
      if (closing) throw new Error("Resource management is closing");
    },
    close: async () => {}, // The fleet owns all controller lifetimes.
    create: route("create"),
    release: route("release"),
    refreshServices: route("refreshServices"),
    listWorkspaceDirectory: route("listWorkspaceDirectory"),
    readWorkspaceFile: route("readWorkspaceFile"),
    listAssignments: async (sandboxId) =>
      (
        await Promise.all(
          [...entries.values()].map((e) => e.runtime.controller.listAssignments(sandboxId)),
        )
      ).flat(),
    terminateAndConfirmAbsent: route("terminateAndConfirmAbsent"),
    confirmAbsent: route("confirmAbsent"),
    provisionDevelopmentEnvironment: route("provisionDevelopmentEnvironment"),
    developmentEnvironmentLifecycle: route("developmentEnvironmentLifecycle"),
    observeDevelopmentEnvironment: route("observeDevelopmentEnvironment"),
    browseDevelopmentEnvironment: route("browseDevelopmentEnvironment"),
    openDevelopmentEnvironmentTerminal: route("openDevelopmentEnvironmentTerminal"),
    openTerminal: route("openTerminal"),
    authorizeSourceCredential: route("authorizeSourceCredential"),
    preflightSourceCredential: route("preflightSourceCredential"),
    listSourceCredentials: route("listSourceCredentials"),
    disconnectSourceCredential: route("disconnectSourceCredential"),
    prepareWorkspaceUpload: route("prepareWorkspaceUpload"),
    uploadWorkspaceFile: route("uploadWorkspaceFile"),
    prepareWorkspaceFileTransfer: route("prepareWorkspaceFileTransfer"),
    workspaceFileTransfer: route("workspaceFileTransfer"),
  };
  const server = new SandboxControlServer({
    host: config.host,
    port: config.port,
    serviceToken: config.serviceToken,
    terminalToken: config.terminalToken,
    ...(config.workspaceServiceToken
      ? { workspaceServiceToken: config.workspaceServiceToken }
      : {}),
    broker: backend,
    managementOnly: true,
    metrics: options.metrics,
    executionBaseUrl: config.sessionExecutionBaseUrl,
    retainResources: async (uses) => {
      let count = 0;
      for (const entry of entries.values())
        if (entry.runtime.ready) count += await entry.runtime.retainResources(uses);
      return count;
    },
  });
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      abort.abort();
      started = false;
      await watching;
      await reconciling;
      const settled = await Promise.allSettled([
        server.close(),
        wake.close(),
        ...[...entries.values()].map((e) => e.runtime.close()),
      ]);
      const errors = settled.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
      if (errors.length) throw new AggregateError(errors, "Resource backend fleet cleanup failed");
    })());
  try {
    if (!(await registry.list()).some((b) => b.resource.id === config.sandboxDomainId)) {
      const storage = new HttpWorkspaceVolumeGateway({
        baseUrl: config.storage.url,
        serviceToken: config.storage.token,
      });
      let poolId: string;
      try {
        poolId = (await storage.persistenceInfo()).poolId;
      } finally {
        await storage.close();
      }
      const native = config.runtimeProvider === "boxlite" ? config.boxlite! : config.cubeSandbox!;
      const configuration: ResourceBackendConfiguration = {
        storage: { url: config.storage.url, token: config.storage.token, poolId },
        webProxy: {
          ...config.webProxy,
          directPrivateCidrs: [...config.webProxy.directPrivateCidrs],
        },
        compute:
          config.runtimeProvider === "boxlite"
            ? {
                provider: "boxlite",
                url: config.boxlite!.url,
                nodeId: config.boxlite!.nodeId,
                token: config.serviceToken,
              }
            : { provider: "cubesandbox", ...config.cubeSandbox! },
        templates: [
          {
            id: "linux",
            name: "Linux",
            operatingSystem: "Ubuntu 24.04",
            imageRevision: config.imageRevision,
            elasticTemplateId: native.templateId,
            profiles: { ...native.developmentTemplateIds },
          },
        ],
      };
      // Pick only fields accepted by the private registry schema.
      if (configuration.compute.provider === "cubesandbox") {
        const c = config.cubeSandbox!;
        configuration.compute = {
          provider: "cubesandbox",
          apiUrl: c.apiUrl,
          apiKey: c.apiKey,
          proxyNodeIp: c.proxyNodeIp,
          proxyPort: c.proxyPort,
          proxyScheme: c.proxyScheme,
          sandboxDomain: c.sandboxDomain,
          ...(c.lifecycleRedisUrl ? { lifecycleRedisUrl: c.lifecycleRedisUrl } : {}),
          ...(c.lifecycleRedisPassword ? { lifecycleRedisPassword: c.lifecycleRedisPassword } : {}),
        };
      }
      await registry.bootstrap({
        id: config.sandboxDomainId,
        name: "Primary",
        location: "Local",
        state: "active",
        configuration,
      });
    }
    await refresh();
    await server.listen();
    return {
      registry,
      refresh,
      close,
      get ready() {
        return started && !closing;
      },
      observeMachine: (...args: Parameters<Runtime["observeMachine"]>) => {
        for (const entry of entries.values()) {
          const found = entry.runtime.observeMachine(...args);
          if (found) return found;
        }
      },
      async start() {
        if (watching || closing)
          throw new Error("Resource backend fleet already started or closed");
        started = true;
        watching = (async () => {
          while (!abort.signal.aborted) {
            wake.refresh();
            const generation = wake.generation;
            await refresh().catch(() => {});
            await wake.wait(generation, 15_000, abort.signal);
          }
        })();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export { installResourceBackendRoutes } from "./resource-backend-routes.ts";
