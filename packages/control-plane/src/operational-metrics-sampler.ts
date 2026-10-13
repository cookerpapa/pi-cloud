import type { Database } from "@pi-cloud/database";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import type { SessionProjector } from "@pi-cloud/runtime-core/session-projector";
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
  readonly #events: Pick<SessionProjector, "statistics">;
  readonly #metrics: PiCloudMetrics;
  readonly #sampleIntervalMs: number;
  readonly #onError: ((source: "postgresql" | "kafka", error: unknown) => void) | undefined;
  #timer: NodeJS.Timeout | undefined;
  #sampling: Promise<void> | undefined;

  constructor(options: {
    database: Kysely<Database>;
    events: Pick<SessionProjector, "statistics">;
    metrics: PiCloudMetrics;
    sampleIntervalMs?: number;
    onError?: (source: "postgresql" | "kafka", error: unknown) => void;
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
    const sampling = Promise.all([this.#sampleDatabase(), this.#sampleKafka()]).then(
      () => undefined,
    );
    this.#sampling = sampling.finally(() => {
      this.#sampling = undefined;
    });
    return this.#sampling;
  }

  async #sampleDatabase(): Promise<void> {
    try {
      const {
        rows: [snapshot],
      } = await sql<{
        queued: string;
        purges: string;
        outbox: Array<{ kind: string; count: string; age: number }>;
      }>`select
        (select count(*)::text from runs where state='queued' and available_at<=clock_timestamp()) queued,
        (select count(*)::text from workspaces where deleted_at is not null and storage_purged_at is null) purges,
        coalesce((select jsonb_agg(jsonb_build_object('kind',kind,'count',n::text,'age',age)) from (
          select case when aggregate_type='session_terminal_event' then 'terminal' else payload->>'entity' end kind,
            count(*) n, greatest(0,extract(epoch from clock_timestamp()-min(created_at))) age
          from outbox where published_at is null and aggregate_type in ('session_terminal_event','session_control_change')
          group by 1
        ) pending),'[]'::jsonb) outbox`.execute(this.#database);
      if (!snapshot) throw new Error("Operational snapshot missing");
      this.#metrics.queuedRuns.set(count(snapshot.queued));
      this.#metrics.workspaceStoragePurgePending.set(count(snapshot.purges));
      this.#metrics.terminalEventOutboxPending.set(
        count(snapshot.outbox.find((row) => row.kind === "terminal")?.count ?? "0"),
      );
      for (const entity of ["sandbox_binding", "input_queue", "subagent_state"]) {
        const row = snapshot.outbox.find((row) => row.kind === entity);
        this.#metrics.controlOutboxPending.set({ entity }, count(row?.count ?? "0"));
        this.#metrics.controlOutboxOldestAge.set({ entity }, Number(row?.age ?? 0));
      }
      this.#metrics.operationalSampleTimestamp.set({ source: "postgresql" }, Date.now() / 1_000);
    } catch (error: unknown) {
      this.#metrics.operationalSampleFailures.inc({ source: "postgresql" });
      this.#onError?.("postgresql", error);
    }
  }

  async #sampleKafka(): Promise<void> {
    try {
      const snapshot = this.#events.statistics();
      this.#metrics.kafkaLiveTailSessions.set(snapshot.liveTail.activeSessionTails);
      this.#metrics.kafkaLiveTailEvents.set(snapshot.liveTail.cachedEvents);
      this.#metrics.kafkaLiveTailBytes.set(snapshot.liveTail.cachedBytes);
      this.#metrics.operationalSampleTimestamp.set({ source: "kafka" }, Date.now() / 1_000);
    } catch (error: unknown) {
      this.#metrics.operationalSampleFailures.inc({ source: "kafka" });
      this.#onError?.("kafka", error);
    }
  }
}
