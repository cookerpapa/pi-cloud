import { SubagentControlClient } from "@pi-cloud/sandbox-supervisor";
import { RunCancellationExecutor } from "@pi-cloud/runtime-core/run-cancellation-executor";
import type { ExecutionLogFactory } from "@pi-cloud/runtime-core/execution-log";
import { DirectExecutionLog } from "@pi-cloud/runtime-core/direct-execution-log";
import { KafkaAcceptedFactBus } from "@pi-cloud/runtime-core/kafka-accepted-fact";
import { NativeSessionLogPublisher } from "@pi-cloud/runtime-core/native-session-log-publisher";
import {
  AcceptedFactPublisherFailedError,
  type ActiveExecutionLogResolver,
} from "@pi-cloud/runtime-core/accepted-fact";
import { AgentRunExecutionBackend } from "@pi-cloud/runtime-core/agent-run-execution-backend";
import { RunExecutor } from "@pi-cloud/runtime-core/run-executor";
import { SessionLeaseCoordinator } from "@pi-cloud/runtime-core/session-lease-coordinator";
import { createDatabase, type Database } from "@pi-cloud/database";
import { operationalLog, type PiCloudMetrics } from "@pi-cloud/observability";
import {
  PostgresPiSessionEntryPayloadCache,
  PostgresNativeSessionHost,
} from "@pi-cloud/pi-session-postgres";
import type { SupervisorBootProvisionRequest } from "@pi-cloud/protocol";
import { ReplicatedToolBrokerClient } from "@pi-cloud/tool-broker";
import {
  AgentRunSupervisor,
  RemoteToolSandboxTurnRunner,
  ReconnectingSupervisorWebSocketClient,
  type AgentTurnScenario,
  type AgentTurnScenarioContext,
  type ReconnectingSupervisorWebSocketClientStop,
} from "@pi-cloud/sandbox-supervisor";
import { PostgresTrustedToolRuntime } from "@pi-cloud/trusted-tool-runtime";
import { FamilyModelPermits } from "./family-model-permits.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { SupervisorBootLedger, type SupervisorHostBootIdentity } from "./boot-ledger.ts";
import type { SupervisorHostConfig } from "./config.ts";
import {
  SupervisorManagementServer,
  SupervisorManagementServerError,
} from "./management-server.ts";
import { TenantModelGateway } from "./model-gateway.ts";
import { RunClaimReadinessMonitor } from "./run-claim-readiness.ts";
import {
  PostgresPiWorker,
  type PostgresPiWorkerOptions,
  type PostgresPiWorkerState,
} from "./postgres-pi-worker.ts";
import { SupervisorProvisioningClient } from "./provisioning-client.ts";
import { resolveWorkspaceSeed } from "./workspace-seed.ts";
import { findRetiredRuns } from "./retired-runs.ts";

export type PiWorkerRuntimeState =
  "idle" | "starting" | "ready" | "draining" | "stopped" | "failed";

export type PiWorkerRuntimeOptions = {
  config: SupervisorHostConfig;
  database?: Kysely<Database>;
  provisioningClient?: Pick<SupervisorProvisioningClient, "provision">;
  toolBroker?: SupervisorToolBroker;
  idGenerator?: () => string;
  connectionSecretGenerator?: () => string;
  metrics?: PiCloudMetrics;
  runWorkerFactory?: (options: PostgresPiWorkerOptions) => SupervisorRunWorker;
  executionLogs?: ExecutionLogFactory & {
    checkHealth?(): Promise<void>;
    close?(): Promise<void>;
  };
  sessionMutationProducer?: Pick<NativeSessionLogPublisher, "scoped" | "checkHealth" | "close">;
};

export type SupervisorRunWorker = {
  readonly state: PostgresPiWorkerState;
  start(): Promise<void>;
  stop(): Promise<void>;
  scheduleOwnedSubagent?(runId: string): boolean;
};

function executionLogResolver(value: ExecutionLogFactory): ActiveExecutionLogResolver {
  const candidate = value as Partial<ActiveExecutionLogResolver>;
  if (typeof candidate.resolve !== "function" || typeof candidate.checkHealth !== "function") {
    throw new TypeError("Production ExecutionLogWriter factory does not expose active channels");
  }
  return candidate as ActiveExecutionLogResolver;
}

export type SupervisorToolBroker = Pick<
  ReplicatedToolBrokerClient,
  | "operationResultUrlFor"
  | "checkHealth"
  | "create"
  | "refreshServices"
  | "release"
  | "stop"
  | "listAssignments"
  | "terminateAndConfirmAbsent"
  | "confirmAbsent"
>;

export type SupervisorHostTerminalReason = "owner_stopped" | "connection_failed";

export const PRODUCTION_CANCELLATION_PROBE_PROMPT = "pi-cloud://acceptance/cancellation-hold";

export function resolveProductionSandboxScenario({
  command,
}: AgentTurnScenarioContext): AgentTurnScenario {
  if (
    command.payload.input.kind === "prompt" &&
    command.payload.input.text.startsWith("pi-cloud-eval://")
  ) {
    return "coding_eval";
  }
  if (
    command.payload.input.kind === "prompt" &&
    command.payload.input.text === PRODUCTION_CANCELLATION_PROBE_PROMPT
  ) {
    return "tool_hold";
  }
  return "java_repair";
}

export class PiWorkerRuntimeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean, options?: ErrorOptions) {
    super(safeMessage, options);
    this.name = "PiWorkerRuntimeError";
    this.code = code;
    this.retryable = retryable;
  }
}

function connectionSecret(value: string): string {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) {
    throw new TypeError("Connection secret generator returned an invalid value");
  }
  return value;
}

export class PiWorkerRuntime {
  readonly #config: SupervisorHostConfig;
  readonly #database: Kysely<Database>;
  readonly #ownsDatabase: boolean;
  readonly #provisioningClient: Pick<SupervisorProvisioningClient, "provision">;
  readonly #toolBroker: SupervisorToolBroker;
  readonly #idGenerator: () => string;
  readonly #connectionSecretGenerator: () => string;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #runWorkerFactory: (options: PostgresPiWorkerOptions) => SupervisorRunWorker;
  readonly #executionLogs:
    (ExecutionLogFactory & { checkHealth?(): Promise<void>; close?(): Promise<void> }) | undefined;
  readonly #configuredSessionMutationProducer:
    Pick<NativeSessionLogPublisher, "scoped" | "checkHealth" | "close"> | undefined;
  #sessionMutationProducer:
    Pick<NativeSessionLogPublisher, "scoped" | "checkHealth" | "close"> | undefined;
  #ownsSessionMutationProducer = false;
  #nativeSessions: PostgresNativeSessionHost | undefined;
  #subagentControl: SubagentControlClient | undefined;
  #agentRunner: RemoteToolSandboxTurnRunner | undefined;
  #activeExecutionLogs:
    (ExecutionLogFactory & { checkHealth?(): Promise<void>; close?(): Promise<void> }) | undefined;
  #ownsExecutionLogs = false;
  readonly #ownerStoppedPromise: Promise<void>;
  readonly #resolveOwnerStopped: () => void;
  readonly #terminalPromise: Promise<SupervisorHostTerminalReason>;
  readonly #resolveTerminal: (reason: SupervisorHostTerminalReason) => void;
  #state: PiWorkerRuntimeState = "idle";
  #identity: SupervisorHostBootIdentity | undefined;
  #runSupervisor: AgentRunSupervisor | undefined;
  #assignmentReaper: NodeJS.Timeout | undefined;
  #assignmentReaping: Promise<void> | undefined;
  #client: ReconnectingSupervisorWebSocketClient | undefined;
  #managementServer: SupervisorManagementServer | undefined;
  #modelGateway: TenantModelGateway | undefined;
  #modelPermits: FamilyModelPermits | undefined;
  #runWorker: SupervisorRunWorker | undefined;
  #runClaimReadiness: RunClaimReadinessMonitor | undefined;
  #closing: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #startupFinished = false;
  #stopRequested = false;
  #ownerStopping: Promise<void> | undefined;
  #terminalSettled = false;
  #terminalFailureCode: string | undefined;

  constructor(options: PiWorkerRuntimeOptions) {
    if (
      !Number.isSafeInteger(options.config.maxConcurrentSessions) ||
      options.config.maxConcurrentSessions < 1 ||
      options.config.maxConcurrentSessions > 16
    ) {
      throw new TypeError("Pi SDK Worker runtime capacity must be between 1 and 16");
    }
    if (
      !Number.isSafeInteger(options.config.databaseMaxConnections) ||
      options.config.databaseMaxConnections < 2 ||
      options.config.databaseMaxConnections > 64
    ) {
      throw new TypeError("Pi SDK Worker database pool must be between 2 and 64 connections");
    }
    this.#config = options.config;
    this.#database =
      options.database ??
      createDatabase({
        connectionString: options.config.databaseUrl,
        maxConnections: options.config.databaseMaxConnections,
      });
    this.#ownsDatabase = options.database === undefined;
    this.#provisioningClient =
      options.provisioningClient ??
      new SupervisorProvisioningClient({
        baseUrl: options.config.controlPlaneBaseUrl,
        enrollmentToken: options.config.enrollmentToken,
        allowInsecureHttp: options.config.allowInsecureInternalHttp,
      });
    this.#toolBroker =
      options.toolBroker ??
      new ReplicatedToolBrokerClient({
        baseUrls: options.config.toolBrokerBaseUrls,
        serviceToken: options.config.toolBrokerServiceToken,
        allowInsecureHttp: options.config.allowInsecureInternalHttp,
        requestTimeoutMs: options.config.toolBrokerRequestTimeoutMs,
      });
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#connectionSecretGenerator =
      options.connectionSecretGenerator ?? (() => randomBytes(32).toString("base64url"));
    this.#metrics = options.metrics;
    this.#runWorkerFactory =
      options.runWorkerFactory ?? ((workerOptions) => new PostgresPiWorker(workerOptions));
    this.#executionLogs = options.executionLogs;
    this.#configuredSessionMutationProducer = options.sessionMutationProducer;
    let resolveOwnerStopped!: () => void;
    this.#ownerStoppedPromise = new Promise((resolvePromise) => {
      resolveOwnerStopped = resolvePromise;
    });
    this.#resolveOwnerStopped = resolveOwnerStopped;
    let resolveTerminal!: (reason: SupervisorHostTerminalReason) => void;
    this.#terminalPromise = new Promise((resolvePromise) => {
      resolveTerminal = resolvePromise;
    });
    this.#resolveTerminal = resolveTerminal;
  }

  get state(): PiWorkerRuntimeState {
    return this.#state;
  }

  get identity(): SupervisorHostBootIdentity | undefined {
    return this.#identity === undefined ? undefined : { ...this.#identity };
  }

  get terminalFailureCode(): string | undefined {
    return this.#terminalFailureCode;
  }

  waitUntilOwnerStopped(): Promise<void> {
    return this.#ownerStoppedPromise;
  }

  waitUntilTerminal(): Promise<SupervisorHostTerminalReason> {
    return this.#terminalPromise;
  }

  start(): Promise<void> {
    if (this.#state !== "idle") throw new Error("Supervisor host runtime can only start once");
    this.#state = "starting";
    this.#starting = this.#start().finally(() => {
      this.#startupFinished = true;
    });
    return this.#starting.catch(async (error: unknown) => {
      this.#state = "failed";
      let failure = error;
      try {
        await this.close();
      } catch (cleanupError) {
        failure = new AggregateError([error, cleanupError], "Worker startup and cleanup failed", {
          cause: error,
        });
      }
      if (failure instanceof PiWorkerRuntimeError) throw failure;
      throw new PiWorkerRuntimeError(
        "pi_worker_start_failed",
        "Supervisor host failed to start",
        true,
        { cause: failure },
      );
    });
  }

  #assertStarting(): void {
    if (this.#stopRequested)
      throw new PiWorkerRuntimeError(
        "pi_worker_start_cancelled",
        "Worker stopped during startup",
        false,
      );
  }

  async #start(): Promise<void> {
    const identity: SupervisorHostBootIdentity = {
      supervisorId: this.#config.supervisorId,
      bootId: this.#idGenerator(),
      sandboxId: this.#idGenerator(),
    };
    this.#identity = identity;
    const ledger = new SupervisorBootLedger({
      rootDirectory: this.#config.bootStateDirectory,
      supervisorId: identity.supervisorId,
      idGenerator: this.#idGenerator,
    });
    await ledger.beginBoot(identity);
    this.#assertStarting();

    let client: ReconnectingSupervisorWebSocketClient | undefined;
    const managementServer = new SupervisorManagementServer({
      host: this.#config.managementHost,
      port: this.#config.managementPort,
      managementToken: this.#config.managementToken,
      identity,
      bootLedger: ledger,
      readiness: () =>
        this.#state === "ready" &&
        client?.state === "connected" &&
        this.#runWorker?.state === "running" &&
        this.#runClaimReadiness?.ready === true,
      stopCurrentBoot: () => this.#stopCurrentBoot(),
      assignmentInventory: this.#toolBroker,
      subagentCommand: async (command) => {
        if (!this.#nativeSessions || !this.#subagentControl)
          throw new Error("Subagent runtime is not ready");
        if (command.action === "input") {
          if (!this.#nativeSessions.hasExecution(command.executionReference) || !this.#agentRunner)
            throw Object.assign(new Error("Target Agent execution is not ready on this Worker"), {
              retryable: true,
            });
          return this.#agentRunner.agentInput(
            command.runId,
            command.requestId,
            command.message,
            command.delivery,
            command.executionReference,
          );
        } else if (command.action === "prepare_lane") {
          await this.#nativeSessions.createChildLane({
            executionReference: command.executionReference,
            lane: command.lane,
            at: command.anchor,
          });
        } else if (command.action === "result") {
          this.#subagentControl.receive(command.executionReference, command.response);
        } else {
          this.#runWorker?.scheduleOwnedSubagent?.(command.runId);
        }
      },
      steerCommand: async (command) => {
        const local = this.#runSupervisor;
        if (local === undefined) {
          throw new SupervisorManagementServerError(
            "steer_target_unavailable",
            "Pi Run is not active on this Worker",
            true,
          );
        }
        const prepared = local.prepareSteer(command);
        if (prepared.ack.payload.status === "rejected") {
          throw new SupervisorManagementServerError(
            prepared.ack.payload.code,
            prepared.ack.payload.message,
            prepared.ack.payload.retryable,
          );
        }
        await prepared.run();
      },
    });
    this.#managementServer = managementServer;
    await managementServer.listen();
    this.#assertStarting();
    await sql`select 1`.execute(this.#database);
    this.#assertStarting();

    const secret = connectionSecret(this.#connectionSecretGenerator());
    const request: SupervisorBootProvisionRequest = {
      protocolVersion: 1,
      type: "supervisor.boot.provision",
      requestId: this.#idGenerator(),
      supervisorId: identity.supervisorId,
      bootId: identity.bootId,
      sandboxId: identity.sandboxId,
      credentialId: this.#idGenerator(),
      credentialSha256: createHash("sha256").update(secret).digest("hex"),
      maxConcurrentSessions: this.#config.maxConcurrentSessions,
      managementBaseUrl: this.#config.managementAdvertisedBaseUrl,
    };
    await this.#provisioningClient.provision(request);
    this.#assertStarting();

    const modelGateway = new TenantModelGateway({
      host: this.#config.modelGatewayHost,
      port: this.#config.modelGatewayPort,
      advertisedBaseUrl: this.#config.modelGatewayAdvertisedBaseUrl,
      providerGatewayBaseUrl: this.#config.providerGatewayBaseUrl,
      providerGatewayApiKey: this.#config.providerGatewayApiKey,
      capabilityTtlMs: this.#config.modelGatewayCapabilityTtlMs,
      maximumRequestsPerTurn: this.#config.modelGatewayMaximumRequestsPerTurn,
      upstreamConnectTimeoutMs: this.#config.modelGatewayUpstreamConnectTimeoutMs,
      upstreamIdleTimeoutMs: this.#config.modelGatewayUpstreamIdleTimeoutMs,
      piRequestTimeoutMs: this.#config.piModelRequestTimeoutMs,
      piTurnTimeoutMs: this.#config.piTurnTimeoutMs,
      ...(this.#metrics === undefined ? {} : { metrics: this.#metrics }),
    });
    this.#modelGateway = modelGateway;
    await modelGateway.start();
    this.#assertStarting();
    await modelGateway.checkProviderHealth();
    this.#assertStarting();
    const runWorkerIdentity = `postgres:${identity.supervisorId}:${identity.bootId}`;
    let executionLogs = this.#executionLogs;
    if (!executionLogs) {
      const bus = new KafkaAcceptedFactBus({
        manageTopic: false,
        brokers: this.#config.kafka.brokers,
        partitions: this.#config.kafka.partitions,
        replicas: this.#config.kafka.replicas,
        clientId: runWorkerIdentity,
        capacity: this.#config.producerCapacity,
        ...(this.#metrics ? { metrics: this.#metrics } : {}),
      });
      executionLogs = new DirectExecutionLog(this.#database!, bus, this.#config.producerCapacity);
      this.#activeExecutionLogs = executionLogs;
      this.#ownsExecutionLogs = true;
      await bus.start();
      this.#assertStarting();
    }
    this.#activeExecutionLogs = executionLogs;
    this.#ownsExecutionLogs = this.#executionLogs === undefined;
    await executionLogs.checkHealth?.();
    this.#assertStarting();
    const sessionMutationProducer =
      this.#configuredSessionMutationProducer ??
      new NativeSessionLogPublisher({
        channels: executionLogResolver(executionLogs),
        ...(this.#metrics ? { metrics: this.#metrics } : {}),
      });
    this.#ownsSessionMutationProducer = this.#configuredSessionMutationProducer === undefined;
    this.#sessionMutationProducer = sessionMutationProducer;
    await sessionMutationProducer.checkHealth();
    this.#assertStarting();
    const runClaimReadiness = new RunClaimReadinessMonitor({
      check: async () => {
        try {
          await Promise.all([executionLogs.checkHealth?.(), modelGateway.checkProviderHealth()]);
        } catch (error) {
          if (error instanceof AcceptedFactPublisherFailedError && this.#state === "ready") {
            operationalLog({
              service: "pi-cloud-pi-worker",
              level: "error",
              event: "execution-log.failed",
              attributes: { failureCode: error.code },
            });
            this.#terminalFailureCode = error.code;
            this.#state = "failed";
            this.#client?.setAcceptingAssignments(false);
            this.#runSupervisor?.revokeAllAssignments();
            this.#settleTerminal("connection_failed");
          }
          throw error;
        }
      },
    });
    this.#runClaimReadiness = runClaimReadiness;
    await runClaimReadiness.start();
    this.#assertStarting();
    const sessionEntryPayloadCache = new PostgresPiSessionEntryPayloadCache();
    const nativeSessions = new PostgresNativeSessionHost({
      database: this.#database,
      entryPayloadCache: sessionEntryPayloadCache,
      ...(this.#metrics
        ? {
            onViewRead: (sample) => {
              this.#metrics!.sessionViewReads.inc({ source: sample.source });
              this.#metrics!.sessionViewReadDuration.observe(
                { source: sample.source },
                sample.durationMs / 1000,
              );
              this.#metrics!.sessionViewStorageBytes.inc(sample.storageBytes);
            },
          }
        : {}),
    });
    this.#nativeSessions = nativeSessions;
    this.#subagentControl = new SubagentControlClient((lease) =>
      executionLogResolver(executionLogs).resolve(lease),
    );
    const trustedTools = new PostgresTrustedToolRuntime({
      database: this.#database,
      nativeLanes: nativeSessions,
      control: this.#subagentControl,
      treePolicy: {
        maximumDepth: this.#config.subagentMaximumDepth,
        maximumNodes: this.#config.subagentMaximumNodes,
      },
    });
    const modelPermits = new FamilyModelPermits({
      maximum: this.#config.modelConcurrency,
      perFamily: this.#config.familyModelConcurrency,
      onWait: (ms) => this.#metrics?.modelPermitWait.observe(ms / 1000),
      onChange: (sample) => {
        this.#metrics?.modelPermitsActive.set(sample.active);
        this.#metrics?.modelPermitsWaiting.set(sample.waiting);
      },
    });
    this.#modelPermits = modelPermits;
    const runner = new RemoteToolSandboxTurnRunner({
      acquireModelPermit: (command, signal) =>
        modelPermits.acquire(`${command.payload.tenantId}:${command.payload.piSession.id}`, signal),
      publishToolCommand: (command) => {
        const channel = executionLogResolver(executionLogs).resolve(command.executionReference);
        if (!channel) throw new Error("Tool command Fact Stream is unavailable");
        return channel.publishToolCommand(command);
      },
      broker: this.#toolBroker,
      runtimeIdentity: identity,
      trustedWorkspaceDirectory: this.#config.trustedWorkspaceDirectory,
      openAgentSession: (command, readSignal) =>
        nativeSessions.open({
          ...(readSignal ? { readSignal } : {}),
          scope: {
            tenantId: command.payload.tenantId,
            sessionId: command.payload.sessionId,
            piSessionId: command.payload.piSession.id,
            piSessionLane: command.payload.piSession.lane,
            turnId: command.payload.turnId,
            runId: command.payload.runId,
          },
          executionReference: command.payload.executionReference,
          writerId: command.payload.piSession.writerId,
          publisher: sessionMutationProducer.scoped({
            tenantId: command.payload.tenantId,
            sessionId: command.payload.sessionId,
            piSessionId: command.payload.piSession.id,
            piSessionLane: command.payload.piSession.lane,
            writerId: command.payload.piSession.writerId,
            turnId: command.payload.turnId,
            runId: command.payload.runId,
            executionReference: command.payload.executionReference,
          }),
        }),
      createTrustedTools: (command, context) => trustedTools.create({ command, ...context }),
      scenario: resolveProductionSandboxScenario,
      modelRuntimeLeaseResolver: (command) => modelGateway.issue(command),
      workspaceSeedResolver: resolveWorkspaceSeed,
      turnTimeoutMs: this.#config.piTurnTimeoutMs,
      ...(this.#metrics === undefined ? {} : { metrics: this.#metrics }),
    });
    this.#agentRunner = runner;
    await runner.warm();
    this.#assertStarting();
    const runSupervisor = new AgentRunSupervisor({
      runner,
      maxConcurrentSessions: this.#config.maxConcurrentSessions,
      maximumLanesPerFamily: this.#config.subagentMaximumNodes + 1,
    });
    this.#runSupervisor = runSupervisor;
    client = new ReconnectingSupervisorWebSocketClient({
      url: this.#config.supervisorWebSocketUrl,
      authorizationHeader: `Bearer ${request.credentialId}.${secret}`,
      registration: {
        ...identity,
        maxConcurrentSessions: this.#config.maxConcurrentSessions,
      },
      runtime: runSupervisor,
    });
    // The WebSocket remains a liveness/ownership and management channel.
    // PostgreSQL is the sole production authority that assigns Run work.
    client.setAcceptingAssignments(false);
    this.#client = client;
    await client.start();
    this.#assertStarting();
    const leaseCoordinator = new SessionLeaseCoordinator({
      database: this.#database,
      sandboxId: identity.sandboxId,
      ...(this.#metrics === undefined ? {} : { metrics: this.#metrics }),
    });
    const runBackend = new AgentRunExecutionBackend({
      supervisor: runSupervisor,
      leaseCoordinator,
      executionLogs,
      ...(this.#metrics === undefined ? {} : { metrics: this.#metrics }),
      onUnexpectedError: (error) =>
        operationalLog({
          service: "pi-cloud-pi-worker",
          level: "error",
          event: "supervisor.execution-unexpected-failure",
          attributes: {
            name: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : "Unknown execution failure",
          },
        }),
    });
    const runWorker = this.#runWorkerFactory({
      database: this.#database,
      notificationConnectionString: this.#config.databaseNotificationUrl,
      identity: runWorkerIdentity,
      maximumActiveFamilies: this.#config.maxConcurrentSessions,
      maximumLanesPerFamily: this.#config.subagentMaximumNodes + 1,
      onCapacity: (sample) => this.#metrics?.activeSessionFamilies.set(sample.families),
      canClaimRuns: () =>
        (this.#state === "ready" || this.#state === "draining") && client?.state === "connected",
      admitRunClaims: async () => runClaimReadiness.ready,
      runExecutor: new RunExecutor({
        database: this.#database,
        backend: runBackend,
        executionAuthority: leaseCoordinator,
        claimOwnerId: runWorkerIdentity,
        ...(this.#metrics === undefined ? {} : { metrics: this.#metrics }),
      }),
      cancellationExecutor: new RunCancellationExecutor({
        database: this.#database,
        backend: runBackend,
        executionAuthority: leaseCoordinator,
      }),
      onFailure: (operation, error) =>
        operationalLog({
          service: "pi-cloud-pi-worker",
          level: "error",
          event: "postgres-run-worker.failure",
          attributes: {
            operation,
            name: error instanceof Error ? error.name : "UnknownError",
            code:
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
                : "unexpected_error",
            message:
              error instanceof Error ? error.message : "Unexpected PostgreSQL Worker failure",
          },
        }),
    });
    this.#runWorker = runWorker;
    await runWorker.start();
    this.#assertStarting();
    this.#state = "ready";
    this.#assignmentReaper = setInterval(() => {
      if (this.#assignmentReaping) return;
      this.#assignmentReaping = runSupervisor
        .reapSettled((ids) => findRetiredRuns(this.#database, ids))
        .then((retired) => {
          if (retired)
            operationalLog({
              service: "pi-cloud-pi-worker",
              level: "info",
              event: "runtime.assignments-reaped",
              attributes: { retired, ...runSupervisor.retainedState },
            });
        })
        .catch(() =>
          operationalLog({
            service: "pi-cloud-pi-worker",
            level: "error",
            event: "runtime.assignment-reap-failed",
            attributes: { code: "retirement_check_failed" },
          }),
        )
        .finally(() => {
          this.#assignmentReaping = undefined;
        });
    }, 60_000);
    this.#assignmentReaper.unref();
    void client.waitUntilStopped().then((result) => this.#observeClientStop(result));
  }

  #stopCurrentBoot(): Promise<void> {
    this.#ownerStopping ??= (async () => {
      // A drain is not an exit proof. Revoke and join even when close() has
      // already set draining, and prevent suspended startup from admitting work.
      this.#stopRequested = true;
      this.#state = "draining";
      clearInterval(this.#assignmentReaper);
      this.#client?.setAcceptingAssignments(false);
      this.#runSupervisor?.revokeAllAssignments();
      await this.#runWorker?.stop();
      await this.#client?.stop();
      await this.#runSupervisor?.waitUntilAssignmentsSettled();
      this.#resolveOwnerStopped();
      this.#settleTerminal("owner_stopped");
    })();
    return this.#ownerStopping;
  }

  close(): Promise<void> {
    this.#stopRequested = true;
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    clearInterval(this.#assignmentReaper);
    if (this.#state !== "failed") this.#state = "draining";
    const errors: unknown[] = [];
    if (this.#starting && !this.#startupFinished) {
      // Registration can wait for reconnect indefinitely. Interrupt existing
      // startup waiters, then join acquisition before disposing its resources.
      for (const stop of [() => this.#client?.stop(), () => this.#runWorker?.stop()]) {
        try {
          await stop();
        } catch (error) {
          errors.push(error);
        }
      }
      await this.#starting.catch(() => undefined); // start() reports the startup failure.
    }
    if (this.#ownerStopping) {
      try {
        await this.#ownerStopping;
      } catch (error) {
        errors.push(error);
      }
    }
    this.#client?.setAcceptingAssignments(false);
    this.#runClaimReadiness?.close();
    this.#runClaimReadiness = undefined;
    // A Kubernetes scale-in is a drain, not a fencing event. Stop queue
    // polling first and give the active Runs their bounded settlement window;
    // owner replacement still uses stopCurrentBoot(), which revokes immediately.
    for (const close of [
      () => this.#runWorker?.stop(),
      () => this.#runSupervisor?.waitUntilAssignmentsSettled(),
      () => this.#modelPermits?.close(),
      () => this.#nativeSessions?.close(),
      () => this.#subagentControl?.close(),
      () => this.#client?.stop(),
      () => this.#managementServer?.close(),
      () => this.#modelGateway?.close(),
      () =>
        this.#ownsSessionMutationProducer ? this.#sessionMutationProducer?.close() : undefined,
      () => (this.#ownsExecutionLogs ? this.#activeExecutionLogs?.close?.() : undefined),
      // A retirement read must finish before its pool closes, not before queue admission stops.
      () => this.#assignmentReaping,
      () => (this.#ownsDatabase ? this.#database.destroy() : undefined),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      this.#state = "failed";
      throw new PiWorkerRuntimeError(
        "pi_worker_cleanup_failed",
        "Pi Worker resource cleanup failed",
        false,
        { cause: new AggregateError(errors, "Worker cleanup failures") },
      );
    }
    if (this.#state !== "failed") this.#state = "stopped";
  }

  #observeClientStop(result: ReconnectingSupervisorWebSocketClientStop): void {
    if (this.#state === "draining" || this.#state === "stopped") return;
    operationalLog({
      service: "pi-cloud-pi-worker",
      level: result.reason === "terminal_failure" ? "error" : "info",
      event: "worker-control-channel.stopped",
      attributes: {
        reason: result.reason,
        failureCode: result.failureCode ?? "none",
        connectionAttempts: result.connectionAttempts,
        successfulConnections: result.successfulConnections,
        closeCode: result.lastClose?.code ?? -1,
        closeReason: result.lastClose?.reason ?? "none",
        closeRetryable: result.lastClose?.retryable ?? false,
        initiatedByClient: result.lastClose?.initiatedByClient ?? false,
      },
    });
    if (result.reason === "terminal_failure" && !this.#terminalSettled) {
      this.#terminalFailureCode = result.failureCode ?? "supervisor_connection_failed";
      this.#state = "failed";
      this.#settleTerminal("connection_failed");
    }
  }

  #settleTerminal(reason: SupervisorHostTerminalReason): void {
    if (this.#terminalSettled) return;
    this.#terminalSettled = true;
    this.#resolveTerminal(reason);
  }
}
