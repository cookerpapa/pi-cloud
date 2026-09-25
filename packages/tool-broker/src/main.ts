import { loadToolBrokerConfig } from "./tool-broker-config.ts";
import { createDatabase } from "@pi-cloud/database";
import { operationalLog, startServiceObservability } from "@pi-cloud/observability";
import { CubeSandboxProvider } from "./cubesandbox-sandbox-provider.ts";
import { ToolBrokerServer } from "./tool-broker-server.ts";
import { ToolBroker } from "./tool-broker.ts";
import { HttpWorkspaceVolumeGateway } from "./workspace-volume-gateway.ts";
import { PostgresWorkspaceRuntimeStateRepository } from "./workspace-runtime-state-repository.ts";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PostgresSandboxHttpServiceRegistry } from "./sandbox-http-service-registry.ts";
import { WorkspaceVolumeDeletionReaper } from "./workspace-volume-deletion-reaper.ts";
import { ToolCommandExecutor } from "./tool-command-executor.ts";
import { KafkaToolReplyPublisher } from "@pi-cloud/event-log";
import { ToolProgressPublisher } from "./tool-progress-publisher.ts";

function reportFailure(error: unknown): void {
  operationalLog({
    service: "pi-cloud-tool-broker",
    level: "error",
    event: "lifecycle.failed",
    attributes: { failureType: error instanceof Error ? error.name : "UnknownError" },
  });
  process.exitCode = 1;
}

export async function startToolBroker(): Promise<{ close: () => Promise<void> }> {
  const config = await loadToolBrokerConfig();
  let database: ReturnType<typeof createDatabase> | undefined;
  let ownership: PostgresWorkspaceRuntimeStateRepository | undefined;
  let observability: Awaited<ReturnType<typeof startServiceObservability>> | undefined;
  let volume: HttpWorkspaceVolumeGateway | undefined;
  let provider: CubeSandboxProvider | undefined;
  let deletionReaper: WorkspaceVolumeDeletionReaper | undefined;
  let broker: ToolBroker | undefined;
  let commands: ToolCommandExecutor | undefined;
  let replies: KafkaToolReplyPublisher | undefined;
  let progress: ToolProgressPublisher | undefined;
  let server: ToolBrokerServer | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
      const errors: unknown[] = [];
      // Each layer takes ownership of the layer below it. Before that handoff,
      // partial startup must close the objects it has actually acquired.
      for (const release of [
        () => deletionReaper?.close(),
        () => commands?.close(),
        () => progress?.close(),
        () => (server ? server.close() : broker ? broker.close() : provider?.close()),
        () => replies?.close(),
        () => (broker ? undefined : ownership?.close()),
        () => (provider ? undefined : volume?.close()),
        () => database?.destroy(),
        () => observability?.close(),
      ]) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, "Tool Broker process cleanup failed", {
          cause: errors[0],
        });
    })();
    return closing;
  };
  const onSignal = () => {
    void close().catch(reportFailure);
  };
  try {
    database = createDatabase({ connectionString: config.databaseUrl, maxConnections: 12 });
    const instanceId = randomUUID();
    ownership = new PostgresWorkspaceRuntimeStateRepository({
      database,
      sandboxDomainId: config.sandboxDomainId,
      instanceId,
      ownerBaseUrl: config.advertisedBaseUrl,
      leaseMs: config.ownershipLeaseMs,
      heartbeatMs: config.ownershipHeartbeatMs,
    });
    await ownership.start();
    observability = await startServiceObservability({
      serviceName: "pi-cloud-tool-broker",
      defaultMetricsPort: 9466,
    });
    const cube = config.cubeSandbox;
    volume = new HttpWorkspaceVolumeGateway({
      baseUrl: cube.workspaceVolumeGatewayUrl,
      serviceToken: cube.workspaceVolumeGatewayToken,
      requestTimeoutMs: cube.workspaceVolumeGatewayRequestTimeoutMs,
    });
    provider = new CubeSandboxProvider({
      templateId: cube.templateId,
      developmentTemplateIds: cube.developmentTemplateIds,
      imageRevision: config.imageRevision,
      persistentStateKey: config.persistentStateKey,
      runtime: {
        apiUrl: cube.apiUrl,
        apiKey: cube.apiKey,
        proxyNodeIp: cube.proxyNodeIp,
        proxyPort: cube.proxyPort,
        proxyScheme: cube.proxyScheme,
        sandboxDomain: cube.sandboxDomain,
        egressProxyIp: cube.egressProxyHost,
        directPrivateCidrs: [...cube.directPrivateCidrs],
        requestTimeoutMs: cube.requestTimeoutMs,
      },
      webProxy: {
        host: cube.egressProxyHost,
        port: cube.egressProxyPort,
        directPrivateCidrs: [...cube.directPrivateCidrs],
      },
      workspaceVolumeGateway: volume,
    });
    const ownedProvider = provider;
    deletionReaper = new WorkspaceVolumeDeletionReaper({
      database,
      sandboxDomainId: config.sandboxDomainId,
      gateway: volume,
      deleteVolumeMetadata: (volumeId) => ownedProvider.deleteWorkspaceVolume(volumeId),
      intervalMs: config.workspaceDeletionReaperIntervalMs,
      batchSize: config.workspaceDeletionReaperBatchSize,
    });
    broker = new ToolBroker({
      provider,
      ownerBaseUrl: config.advertisedBaseUrl,
      stateRepository: ownership,
      imageRevision: config.imageRevision,
      maximumActiveSandboxes: config.maximumActiveSandboxes,
      warmTtlMs: config.warmTtlMs,
      maximumWarmWorkspaceRuntimes: config.maximumWarmWorkspaceRuntimes,
      serviceRegistry: new PostgresSandboxHttpServiceRegistry({ database }),
      onMaintenanceError: () =>
        operationalLog({
          service: "pi-cloud-tool-broker",
          level: "warn",
          event: "maintenance.failed",
        }),
    });
    replies = new KafkaToolReplyPublisher(config.kafkaBrokers, `tool-replies-${instanceId}`);
    await replies.start();
    const replyPublisher = replies;
    progress = new ToolProgressPublisher(config.controlPlaneUrl, config.dispatchToken);
    commands = new ToolCommandExecutor({
      progress,
      broker,
      publishReply: (topic, reply) => replyPublisher.publish(topic, reply),
      maximumActiveCommands: config.maximumActiveCommands,
      metrics: observability.metrics,
    });
    const ownedCommands = commands,
      ownedAuthority = ownership;
    server = new ToolBrokerServer({
      host: config.host,
      port: config.port,
      serviceToken: config.serviceToken,
      terminalToken: config.terminalToken,
      ...(config.workspaceServiceToken === undefined
        ? {}
        : { workspaceServiceToken: config.workspaceServiceToken }),
      broker,
      logDelivery: {
        instanceId,
        token: config.dispatchToken,
        receive: (delivery) => {
          ownedAuthority.assertLocalOwnership();
          ownedCommands.receive({ ...delivery, offset: BigInt(delivery.offset) });
        },
        checkHealth: () => ownedCommands.checkHealth(),
      },
      metrics: observability.metrics,
    });
    await broker.recoverPersistentDevelopmentEnvironments();
    await server.listen();
    deletionReaper.start();
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    process.stdout.write("PiCloud Tool Broker ready\n");
    return { close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Tool Broker startup/cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href)
  void startToolBroker().catch(reportFailure);
