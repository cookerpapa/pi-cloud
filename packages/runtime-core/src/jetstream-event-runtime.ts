import type { Database } from "@pi-cloud/database";
import type { StreamInfo } from "@nats-io/jetstream";
import type { Kysely } from "kysely";
import {
  JetStreamAcceptedAgentEventPublisher,
  FactChannelService,
  JetStreamLiveEventStore,
  JetStreamTerminalEventOutboxRelay,
  JetStreamTerminalTurnProjectionSource,
} from "./jetstream-agent-event-log.ts";
import {
  JetStreamPiSessionMutationProjector,
  PI_SESSION_MUTATION_PROJECTOR_CONSUMER,
} from "./jetstream-pi-session-mutations.ts";
import {
  AGENT_EVENT_STREAM_NAME,
  connectPiCloudJetStream,
  ensurePiCloudStreams,
  PI_SESSION_MUTATION_STREAM_NAME,
  type JetStreamAuthorityConfiguration,
} from "./jetstream-runtime.ts";
import { SessionEventHub } from "./session-event-hub.ts";
import { PostgresExecutionGrantAuthorityGate } from "./execution-grant-authority-gate.ts";
import { JetStreamAcceptedFactBus } from "./jetstream-accepted-fact-bus.ts";
import { PostgresAcceptedFactProgressStore } from "./postgres-accepted-fact-progress.ts";

export type JetStreamEventRuntimeOptions = Readonly<{
  database: Kysely<Database>;
  servers: readonly string[];
  instanceId: string;
  authority: JetStreamAuthorityConfiguration;
  factChannelLeaseMs?: number;
  factChannelMaximumActive?: number;
}>;

export type JetStreamOperationalSnapshot = Readonly<{
  streams: readonly Readonly<{
    name: string;
    messages: number;
    bytes: number;
    unavailableReplicas: number;
  }>[];
  consumers: readonly Readonly<{
    stream: string;
    name: string;
    pending: number;
  }>[];
  factChannels: ReturnType<FactChannelService["statistics"]>;
}>;

function unavailableReplicas(info: StreamInfo): number {
  if (info.cluster === undefined) return 0;
  const leaderUnavailable = info.cluster.leader === undefined ? 1 : 0;
  return (
    leaderUnavailable +
    (info.cluster.replicas ?? []).filter((replica) => replica.offline || !replica.current).length
  );
}

export class JetStreamEventRuntime {
  readonly eventHub = new SessionEventHub();
  readonly eventStore: JetStreamLiveEventStore;
  readonly terminalTurnProjectionSource: JetStreamTerminalTurnProjectionSource;
  readonly factChannels: FactChannelService;
  readonly #runtime;
  readonly #sessionProjector: JetStreamPiSessionMutationProjector;
  readonly #terminalRelay: JetStreamTerminalEventOutboxRelay;
  readonly #authorityConfiguration: JetStreamAuthorityConfiguration;
  #started = false;

  private constructor(options: {
    database: Kysely<Database>;
    runtime: Awaited<ReturnType<typeof connectPiCloudJetStream>>;
    authority: JetStreamAuthorityConfiguration;
    instanceId: string;
    factChannelLeaseMs?: number;
    factChannelMaximumActive?: number;
  }) {
    this.#runtime = options.runtime;
    this.#authorityConfiguration = options.authority;
    const publisher = new JetStreamAcceptedAgentEventPublisher(this.#runtime);
    this.factChannels = new FactChannelService({
      authority: new PostgresExecutionGrantAuthorityGate({
        database: options.database,
        ...(options.factChannelLeaseMs === undefined
          ? {}
          : { leaseDurationMs: options.factChannelLeaseMs }),
      }),
      bus: new JetStreamAcceptedFactBus(this.#runtime),
      progress: new PostgresAcceptedFactProgressStore(options.database),
      instanceId: options.instanceId,
      ...(options.factChannelLeaseMs === undefined
        ? {}
        : { leaseDurationMs: options.factChannelLeaseMs }),
      ...(options.factChannelMaximumActive === undefined
        ? {}
        : { maximumActiveChannels: options.factChannelMaximumActive }),
    });
    this.eventStore = new JetStreamLiveEventStore({
      database: options.database,
      runtime: this.#runtime,
      eventHub: this.eventHub,
    });
    this.terminalTurnProjectionSource = new JetStreamTerminalTurnProjectionSource({
      database: options.database,
      events: this.eventStore,
    });
    this.#sessionProjector = new JetStreamPiSessionMutationProjector({
      database: options.database,
      runtime: this.#runtime,
    });
    this.#terminalRelay = new JetStreamTerminalEventOutboxRelay({
      database: options.database,
      publisher,
    });
  }

  static async create(options: JetStreamEventRuntimeOptions): Promise<JetStreamEventRuntime> {
    const runtime = await connectPiCloudJetStream({
      servers: options.servers,
      clientName: `${options.instanceId}-event-runtime`,
    });
    return new JetStreamEventRuntime({
      database: options.database,
      runtime,
      authority: options.authority,
      instanceId: options.instanceId,
      ...(options.factChannelLeaseMs === undefined
        ? {}
        : { factChannelLeaseMs: options.factChannelLeaseMs }),
      ...(options.factChannelMaximumActive === undefined
        ? {}
        : { factChannelMaximumActive: options.factChannelMaximumActive }),
    });
  }

  private streamInfo(name: string) {
    return this.#runtime.manager.streams.info(name);
  }

  async operationalSnapshot(): Promise<JetStreamOperationalSnapshot> {
    const [agentEvents, sessionMutations, sessionProjector] = await Promise.all([
      this.streamInfo(AGENT_EVENT_STREAM_NAME),
      this.streamInfo(PI_SESSION_MUTATION_STREAM_NAME),
      this.#runtime.manager.consumers.info(
        PI_SESSION_MUTATION_STREAM_NAME,
        PI_SESSION_MUTATION_PROJECTOR_CONSUMER,
      ),
    ]);
    return {
      streams: [agentEvents, sessionMutations].map((info) => ({
        name: info.config.name,
        messages: info.state.messages,
        bytes: info.state.bytes,
        unavailableReplicas: unavailableReplicas(info),
      })),
      consumers: [
        {
          stream: sessionProjector.stream_name,
          name: sessionProjector.name,
          pending: sessionProjector.num_pending + sessionProjector.num_ack_pending,
        },
      ],
      factChannels: this.factChannels.statistics(),
    };
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("JetStream event runtime can only start once");
    await ensurePiCloudStreams(this.#runtime, this.#authorityConfiguration);
    this.eventStore.start();
    await this.#sessionProjector.start();
    this.#terminalRelay.start();
    this.#started = true;
  }

  async checkHealth(): Promise<void> {
    if (!this.#started) throw new Error("JetStream event runtime is not running");
    this.eventStore.checkHealth();
    this.#sessionProjector.checkHealth();
    this.#terminalRelay.checkHealth();
    await this.factChannels.checkHealth();
  }

  async close(): Promise<void> {
    if (!this.#started) {
      await this.#runtime.connection.close().catch(() => undefined);
      return;
    }
    this.#started = false;
    await this.#terminalRelay.close().catch(() => undefined);
    await this.#sessionProjector.close().catch(() => undefined);
    await this.eventStore.close().catch(() => undefined);
    await this.factChannels.close().catch(() => undefined);
    this.eventHub.onApplicationShutdown();
    await this.#runtime.connection.close().catch(() => undefined);
  }
}
