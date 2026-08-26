import type { Database } from "@pi-cloud/database";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import { SESSION_TERMINAL_EVENT_OUTBOX_TOPIC, TURN_COMMAND_OUTBOX_TOPIC } from "@pi-cloud/protocol";
import type {
  JetStreamEventRuntime,
  JetStreamOperationalSnapshot,
} from "@pi-cloud/runtime-core/jetstream-event-runtime";
import { sql, type Kysely } from "kysely";

const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;

function count(value: string | number | bigint): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Operational metric count is outside the safe integer range");
  }
  return parsed;
}

export class OperationalMetricsSampler {
  readonly #database: Kysely<Database>;
  readonly #events: Pick<JetStreamEventRuntime, "operationalSnapshot">;
  readonly #metrics: PiCloudMetrics;
  readonly #sampleIntervalMs: number;
  readonly #onError: ((source: "postgresql" | "jetstream", error: unknown) => void) | undefined;
  #timer: NodeJS.Timeout | undefined;
  #sampling: Promise<void> | undefined;

  constructor(options: {
    database: Kysely<Database>;
    events: Pick<JetStreamEventRuntime, "operationalSnapshot">;
    metrics: PiCloudMetrics;
    sampleIntervalMs?: number;
    onError?: (source: "postgresql" | "jetstream", error: unknown) => void;
  }) {
    this.#database = options.database;
    this.#events = options.events;
    this.#metrics = options.metrics;
    this.#sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.#onError = options.onError;
    if (!Number.isSafeInteger(this.#sampleIntervalMs) || this.#sampleIntervalMs < 1_000) {
      throw new TypeError("Operational metrics sample interval is invalid");
    }
  }

  async start(): Promise<void> {
    if (this.#timer !== undefined)
      throw new Error("Operational metrics sampler is already running");
    await this.sample();
    this.#timer = setInterval(() => {
      void this.sample();
    }, this.#sampleIntervalMs);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#sampling;
  }

  sample(): Promise<void> {
    if (this.#sampling !== undefined) return this.#sampling;
    const sampling = Promise.all([this.#sampleDatabase(), this.#sampleJetStream()]).then(
      () => undefined,
    );
    this.#sampling = sampling.finally(() => {
      this.#sampling = undefined;
    });
    return this.#sampling;
  }

  async #sampleDatabase(): Promise<void> {
    try {
      const now = new Date();
      const queued = await this.#database
        .selectFrom("outbox")
        .innerJoin("commands as command", (join) =>
          join
            .onRef("command.tenant_id", "=", "outbox.tenant_id")
            .on(
              sql<boolean>`${sql.ref("command.id")}::text = ${sql.ref(
                "outbox.payload",
              )} ->> 'commandId'`,
            ),
        )
        .innerJoin("turns as turn", (join) =>
          join
            .onRef("turn.tenant_id", "=", "command.tenant_id")
            .onRef("turn.session_id", "=", "command.session_id")
            .onRef("turn.id", "=", "command.turn_id"),
        )
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("outbox.topic", "=", TURN_COMMAND_OUTBOX_TOPIC)
        .where("outbox.published_at", "is", null)
        .where("outbox.available_at", "<=", now)
        .where("command.state", "=", "pending")
        .where("turn.state", "=", "queued")
        .executeTakeFirstOrThrow();
      const terminalEvents = await this.#database
        .selectFrom("outbox")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("topic", "=", SESSION_TERMINAL_EVENT_OUTBOX_TOPIC)
        .where("published_at", "is", null)
        .executeTakeFirstOrThrow();
      const workspacePurges = await this.#database
        .selectFrom("workspaces")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("deleted_at", "is not", null)
        .where("storage_purged_at", "is", null)
        .executeTakeFirstOrThrow();
      this.#metrics.queuedRuns.set(count(queued.count));
      this.#metrics.terminalEventOutboxPending.set(count(terminalEvents.count));
      this.#metrics.workspaceStoragePurgePending.set(count(workspacePurges.count));
      this.#metrics.operationalSampleTimestamp.set({ source: "postgresql" }, Date.now() / 1_000);
    } catch (error: unknown) {
      this.#metrics.operationalSampleFailures.inc({ source: "postgresql" });
      this.#onError?.("postgresql", error);
    }
  }

  async #sampleJetStream(): Promise<void> {
    try {
      this.#applyJetStreamSnapshot(await this.#events.operationalSnapshot());
      this.#metrics.operationalSampleTimestamp.set({ source: "jetstream" }, Date.now() / 1_000);
    } catch (error: unknown) {
      this.#metrics.operationalSampleFailures.inc({ source: "jetstream" });
      this.#onError?.("jetstream", error);
    }
  }

  #applyJetStreamSnapshot(snapshot: JetStreamOperationalSnapshot): void {
    for (const stream of snapshot.streams) {
      const labels = { stream: stream.name };
      this.#metrics.jetStreamMessages.set(labels, stream.messages);
      this.#metrics.jetStreamBytes.set(labels, stream.bytes);
      this.#metrics.jetStreamUnavailableReplicas.set(labels, stream.unavailableReplicas);
    }
    for (const consumer of snapshot.consumers) {
      this.#metrics.jetStreamConsumerPending.set(
        { stream: consumer.stream, consumer: consumer.name },
        consumer.pending,
      );
    }
    this.#metrics.factChannelsActive.set(snapshot.factChannels.activeChannels);
    this.#metrics.factChannelsLimit.set(snapshot.factChannels.maximumActiveChannels);
    this.#metrics.factChannelRenewalFailures.set(snapshot.factChannels.renewalFailures);
  }
}
