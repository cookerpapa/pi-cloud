import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { KafkaLogConsumer } from "@pi-cloud/event-log";
import {
  ACCEPTED_FACT_TOPIC,
  kafkaProducerLane,
  parseSessionLogFact,
} from "./kafka-accepted-fact.ts";
import { ExecutionStreamProjector, factEvents } from "./execution-stream-projection.ts";
import type {
  AcceptedExecutionSealFact,
  ExecutionPublication,
  SessionLogFact,
} from "./accepted-fact.ts";
import type { PublicationAvailability, SessionControlChange } from "@pi-cloud/protocol";
import { assertCommittedControlChange } from "./session-control-outbox.ts";
import type { ProducerCapacity } from "@pi-cloud/event-log";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import { ExecutionLogTopic, type ExecutionLogTopicOptions } from "./execution-log-topic.ts";
import {
  SessionPublicationIngress,
  PublicationIngressRejected,
} from "./session-publication-ingress.ts";
import { PostgresPublicationControl } from "./postgres-publication-control.ts";
import { HttpPublicationClient } from "./http-publication-client.ts";
import { SessionLiveView } from "./session-live-view.ts";
import { SessionOutboxRelay } from "./session-outbox-relay.ts";
import { KafkaSafeRetention } from "./kafka-safe-retention.ts";
import { loadFactReplayOffsets, recordFactProjection } from "./accepted-fact-recovery.ts";
import type { AcceptedFact } from "./accepted-fact.ts";
import type { KafkaAcceptedFactRecord } from "./kafka-accepted-fact-consumer.ts";
import { toolCommandsForFact } from "./tool-invocation-fact.ts";
import { ProjectionTiming } from "./projection-timing.ts";
import { RunObservations } from "./run-observations.ts";

const PREFIX = "pi-cloud-projector@";
export class SessionProjector {
  readonly eventStore: SessionLiveView;
  readonly eventHub;
  readonly observations: RunObservations;
  readonly #observationSweep: NodeJS.Timeout;
  readonly #consumer: KafkaLogConsumer<SessionLogFact>;
  readonly #topic: ExecutionLogTopic;
  readonly #relay: SessionOutboxRelay;
  readonly #retention: KafkaSafeRetention;
  readonly #projection: ExecutionStreamProjector;
  readonly publication: SessionPublicationIngress;
  readonly #publicationControl: PostgresPublicationControl;
  readonly #publicationClient: HttpPublicationClient;
  #publicationRetirement: Promise<unknown> = Promise.resolve();
  #availabilityEpoch = 0;
  #availabilityCache: { until: number; value: PublicationAvailability } | undefined;
  #availabilityLoading: Promise<PublicationAvailability> | undefined;
  #partitions = 0;
  #ready = false;
  #closing: Promise<void> | undefined;
  constructor(
    readonly options: ExecutionLogTopicOptions & {
      capacity?: ProducerCapacity;
      metrics?: PiCloudMetrics;
      retentionMs: number;
      database: Kysely<Database>;
      notificationConnectionString: string;
      advertisedBaseUrl: string;
      publicationToken: string;
      controlChanges?: {
        load(partitions: readonly number[], current: () => boolean): Promise<void>;
        reset(): void;
        prepare(change: SessionControlChange, current: () => boolean): Promise<void>;
        consume(
          change: SessionControlChange,
          current: () => boolean,
          position: import("@pi-cloud/protocol").ExecutionLogPosition,
        ): Promise<void>;
      };
      executionProbes?: {
        consume(fact: import("@pi-cloud/protocol").PathProbe, current?: () => boolean): void;
        reset(): void;
      };
      toolCommands: {
        consume(record: KafkaAcceptedFactRecord, current?: () => boolean): Promise<void>;
        close?(): Promise<void>;
      };
      subagentCommands?: {
        consume(record: KafkaAcceptedFactRecord, current?: () => boolean): Promise<void>;
        close?(): Promise<void>;
      };
    },
  ) {
    const topic = options.topic ?? ACCEPTED_FACT_TOPIC;
    this.#topic = new ExecutionLogTopic(options);
    this.publication = new SessionPublicationIngress(options.capacity, 65_536, options.metrics);
    this.#publicationControl = new PostgresPublicationControl(
      options.database,
      this.publication,
      async (fact) => {
        const partition = this.publicationPartition(fact.scope.piSessionId);
        // Revoke routing admission before the final seal. Accepted Cube processes
        // are not stopped by sealing. Normal cancellation co-commits its Tool
        // interruption with native Durable abort settlement (ADR-0229); late
        // physical replies cannot replace that settled native result.
        await options.toolCommands.consume({ topic, partition, offset: 0n, fact }, () =>
          this.#consumer.ownsPartition(partition),
        );
      },
    );
    this.#publicationClient = new HttpPublicationClient({
      baseUrl: options.advertisedBaseUrl,
      token: options.publicationToken,
    });
    this.eventStore = new SessionLiveView(async (tenant, session) => {
      const p = await this.#partition(tenant, session);
      if (!this.#consumer.ownsPartition(p))
        throw new Error("Session Projector assignment changed; reconnect");
      await this.#consumer.waitForPartition(p);
    });
    this.eventHub = this.eventStore.eventHub;
    this.observations = new RunObservations(this.eventHub);
    this.#observationSweep = setInterval(() => this.observations.sweep(), 60_000);
    this.#observationSweep.unref();
    this.#projection = new ExecutionStreamProjector(options.database);
    let currentControlAssignment: () => boolean = () => false;
    const groupId = "pi-cloud-session-projector-v2";
    this.#consumer = new KafkaLogConsumer({
      brokers: options.brokers,
      topic,
      groupId,
      readPartitionOwners: () => this.#topic.partitionOwners(groupId),
      clientId:
        PREFIX + Buffer.from(new URL(options.advertisedBaseUrl).toString()).toString("base64url"),
      groupRecovery: true,
      orderedEffects: true,
      decode: parseSessionLogFact,
      replayOffsets: async (bounds) => {
        // Kafka bounds were captured before PG. Read the routing snapshot AFTER
        // choosing the recovery floor: later changes are necessarily replayed.
        // Loading before bounds could skip a change committed during handoff.
        const current = currentControlAssignment;
        const offsets = await loadFactReplayOffsets(options.database, topic, bounds);
        if (current())
          await options.controlChanges?.load(
            bounds.map((b) => b.partition),
            current,
          );
        return offsets;
      },
      onReset: () => {
        this.#projection.reset();
        this.eventStore.reset();
        this.observations.reset();
        options.executionProbes?.reset();
        options.controlChanges?.reset();
      },
      onRevoked: () => {
        this.#availabilityEpoch++;
        this.#availabilityCache = undefined;
        currentControlAssignment = () => false;
        options.controlChanges?.reset();
        const closing: Promise<void>[] = [];
        for (let p = 0; p < options.partitions; p++) closing.push(this.publication.revoke(p));
        this.#publicationRetirement = Promise.allSettled(closing);
      },
      onAssigned: async (partitions, current) => {
        currentControlAssignment = current;
        await this.#publicationRetirement;
        for (const partition of partitions) {
          if (!current()) return;
          const writer = await this.#consumer.openPublicationWriter(partition, current);
          if (!current()) {
            await writer.close();
            return;
          }
          this.publication.installPartition(partition, writer);
        }
      },
      handler: async (raw, current, commitBeforeEffect) => {
        if (raw.fact.kind === "tool_cancel") {
          if (current?.() === false) return;
          // Cancellation is idempotent. Replay it after owner loss even when
          // the original shell dispatch offset was already committed.
          await options.toolCommands.consume({ ...raw, fact: raw.fact }, current);
          if (current?.() !== false)
            await options.database.transaction().execute((tx) => recordFactProjection(tx, raw));
          return;
        }
        if (raw.fact.kind === "control_change") {
          if (current?.() === false) return;
          if (!options.controlChanges && raw.fact.entity === "sandbox_binding")
            throw new Error("Sandbox control view is not installed");
          await options.controlChanges?.consume(raw.fact, current ?? (() => true), {
            topic: raw.topic,
            partition: raw.partition,
            offset: raw.offset.toString(),
          });
          if (current?.() !== false)
            await options.database.transaction().execute((tx) => recordFactProjection(tx, raw));
          return;
        }
        const record = raw as KafkaAcceptedFactRecord;
        const timing = new ProjectionTiming(options.metrics);
        let failure: unknown;
        try {
          if (current?.() === false) return;
          const { fact } = record;
          if (fact.kind === "path_probe") {
            const open = this.#projection.observes(record);
            this.observations.record(record, open);
            if (open) options.executionProbes?.consume(fact, current);
            return;
          }
          const projected = await timing.measure("projection", () =>
            this.#projection.project(record, current ?? (() => true)),
          );
          if (current?.() === false) return;
          if (fact.kind === "execution_seal") {
            const owner = this.publication.ownership(record.partition);
            if (owner) this.publication.confirmSealed(owner, fact);
          }
          if (fact.kind === "durable_commit")
            for (const cancellation of fact.cancellations)
              await options.toolCommands.consume({ ...record, fact: cancellation }, current);
          const applicable =
            fact.kind === "execution_seal" ||
            (await timing.measure("boundary", () => this.#projection.accepts(record)));
          if (current?.() === false) return;
          if (projected?.terminal) this.eventStore.accept(fact.scope.tenantId, projected.terminal);
          if (applicable) {
            for (const event of projected?.events ?? factEvents(fact))
              this.eventStore.accept(fact.scope.tenantId, event);
            for (const cover of projected?.covers ?? [])
              this.eventStore.cover(fact.scope.tenantId, cover.sessionId, cover.through);
            if (projected?.canonicalThroughSequence !== undefined)
              this.eventStore.cover(
                fact.scope.tenantId,
                fact.scope.sessionId,
                projected.canonicalThroughSequence,
              );
            const commands = toolCommandsForFact(fact);
            if (commands.length) {
              if (
                (await timing.measure("dispatch_commit", commitBeforeEffect!)) &&
                current?.() !== false
              )
                for (const command of commands)
                  await timing.measure("tool_route", () =>
                    options.toolCommands.consume({ ...record, fact: command }, current),
                  );
            } else if (fact.kind !== "execution_seal") {
              await timing.measure("tool_route", () =>
                options.toolCommands.consume(record, current),
              );
            }
            if (options.subagentCommands)
              await timing.measure("subagent_route", () =>
                options.subagentCommands!.consume(record, current),
              );
          }
          if (current?.() !== false)
            this.observations.record(record, this.#projection.observes(record));
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          timing.finish(record, failure);
        }
      },
    });
    this.#relay = new SessionOutboxRelay({
      database: options.database,
      notificationConnectionString: options.notificationConnectionString,
      bus: {
        append: (fact) => {
          return fact.kind === "control_change"
            ? this.publishControl(fact)
            : this.publishSeal(fact);
        },
        checkHealth: () => this.#topic.checkHealth(),
      },
    });
    this.#retention = new KafkaSafeRetention({ ...options, topic, graceMs: options.retentionMs });
    this.eventStore.owner = (tenant, session) => this.owner(tenant, session);
  }
  async #partition(tenant: string, sessionId: string): Promise<number> {
    const session = await this.options.database
      .selectFrom("sessions")
      .select("pi_session_id")
      .where("tenant_id", "=", tenant)
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    return kafkaProducerLane(session.pi_session_id, this.#partitions);
  }
  async owner(tenant: string, session: string): Promise<string | undefined> {
    const p = await this.#partition(tenant, session);
    return this.ownerForPartition(p);
  }
  async ownerForPartition(p: number): Promise<string | undefined> {
    if (!Number.isSafeInteger(p) || p < 0 || p >= this.#partitions)
      throw new Error("Invalid Projector partition");
    if (this.#consumer.ownsPartition(p)) return undefined;
    const client = await this.#consumer.ownerClientId(p);
    if (!client?.startsWith(PREFIX)) throw new Error("Session Projector owner unavailable");
    const owner = new URL(
      Buffer.from(client.slice(PREFIX.length), "base64url").toString(),
    ).toString();
    if (owner === new URL(this.options.advertisedBaseUrl).toString())
      throw new Error("Session Projector assignment is settling");
    return owner;
  }
  ownsPartition(partition: number): boolean {
    return this.#consumer.ownsPartition(partition);
  }
  publicationPartition(sessionId: string): number {
    return kafkaProducerLane(sessionId, this.options.partitions);
  }
  async openPublication(permit: ExecutionPublication): Promise<void> {
    const partition = this.publicationPartition(permit.scope.piSessionId);
    const owner = this.publication.ownership(partition);
    if (!owner || !this.#consumer.ownsPartition(partition))
      throw new PublicationIngressRejected("not_owner");
    await this.#publicationControl.open(owner, permit);
  }
  appendPublication(fact: Exclude<AcceptedFact, AcceptedExecutionSealFact>) {
    const partition = this.publicationPartition(fact.scope.piSessionId);
    const owner = this.publication.ownership(partition);
    if (!owner || !this.#consumer.ownsPartition(partition))
      throw new PublicationIngressRejected("not_owner");
    return this.publication.append(owner, fact);
  }
  async publishSeal(fact: AcceptedExecutionSealFact) {
    const partition = this.publicationPartition(fact.scope.piSessionId);
    const owner = this.publication.ownership(partition);
    if (!owner || !this.#consumer.ownsPartition(partition))
      return this.#publicationClient.append(fact);
    return this.#publicationControl.seal(owner, fact);
  }
  async acceptSeal(fact: AcceptedExecutionSealFact) {
    const partition = this.publicationPartition(fact.scope.piSessionId);
    const owner = this.publication.ownership(partition);
    if (!owner || !this.#consumer.ownsPartition(partition))
      throw new PublicationIngressRejected("not_owner");
    return this.#publicationControl.seal(owner, fact);
  }
  async publishControl(change: SessionControlChange) {
    const partition = this.publicationPartition(change.scope.piSessionId);
    if (!this.publication.ownership(partition) || !this.#consumer.ownsPartition(partition))
      return this.#publicationClient.publishControl(change);
    return this.acceptControl(change);
  }
  async acceptControl(change: SessionControlChange) {
    const partition = this.publicationPartition(change.scope.piSessionId);
    const owner = this.publication.ownership(partition);
    if (!owner || !this.#consumer.ownsPartition(partition))
      throw new PublicationIngressRejected("not_owner");
    const current = () =>
      this.publication.ownership(partition) === owner && this.#consumer.ownsPartition(partition);
    await assertCommittedControlChange(this.options.database, change);
    if (!this.options.controlChanges && change.entity === "sandbox_binding")
      throw new Error("Sandbox control view is not installed");
    await this.options.controlChanges?.prepare(change, current);
    if (!current()) throw new PublicationIngressRejected("not_owner");
    return this.publication.control(owner, change);
  }
  async start(): Promise<void> {
    await this.#topic.start();
    // Producer startup already verified this against broker metadata. Asking
    // another client's offset cache merely to count partitions races fresh Topics.
    this.#partitions = this.options.partitions;
    await this.#consumer.start();
    this.#relay.start();
    this.#retention.start(this.#partitions);
    this.#ready = true;
  }
  localPublicationAvailability(): PublicationAvailability {
    const partitions: number[] = [];
    if (this.#ready)
      for (let p = 0; p < this.#partitions; p++)
        if (this.#consumer.ownsPartition(p) && this.publication.ownership(p)) partitions.push(p);
    return { partitionCount: this.options.partitions, partitions };
  }
  async publicationAvailability(): Promise<PublicationAvailability> {
    if (!this.#ready) throw new Error("Projector not started");
    if (this.#availabilityCache && this.#availabilityCache.until > Date.now())
      return this.#availabilityCache.value;
    if (!this.#availabilityLoading) {
      const epoch = this.#availabilityEpoch;
      const loading = (async () => {
        const owners = await this.#consumer.partitionOwners();
        const reports = new Map<string, number[]>();
        for (const [p, client] of owners) {
          if (!client.startsWith(PREFIX) || p < 0 || p >= this.#partitions) continue;
          const owner = new URL(
            Buffer.from(client.slice(PREFIX.length), "base64url").toString(),
          ).toString();
          const partitions = reports.get(owner) ?? [];
          partitions.push(p);
          reports.set(owner, partitions);
        }
        const local = new URL(this.options.advertisedBaseUrl).toString();
        const usable = await Promise.all(
          [...reports].map(async ([owner, assigned]) => {
            try {
              const report =
                owner === local
                  ? this.localPublicationAvailability()
                  : await this.#publicationClient.publicationAvailability(owner, true);
              return report.partitionCount === this.#partitions
                ? assigned.filter((p) => report.partitions.includes(p))
                : [];
            } catch {
              return [];
            }
          }),
        );
        if (!this.#ready || epoch !== this.#availabilityEpoch)
          throw new Error("Projector ownership changed");
        const value = {
          partitionCount: this.#partitions,
          partitions: usable.flat().sort((a, b) => a - b),
        };
        this.#availabilityCache = { value, until: Date.now() + 500 };
        return value;
      })().finally(() => {
        if (this.#availabilityLoading === loading) this.#availabilityLoading = undefined;
      });
      this.#availabilityLoading = loading;
    }
    return this.#availabilityLoading;
  }
  async checkHealth(): Promise<void> {
    await this.checkIngestHealth();
    this.#consumer.checkHealth();
    this.#relay.checkHealth();
    this.#retention.checkHealth();
  }
  async checkIngestHealth(): Promise<void> {
    if (!this.#ready) throw new Error("Projector not started");
    await this.#topic.checkHealth();
  }
  statistics() {
    return { liveTail: this.eventStore.statistics() };
  }
  close(): Promise<void> {
    this.#ready = false;
    return (this.#closing ??= this.#close());
  }
  async #close(): Promise<void> {
    clearInterval(this.#observationSweep);
    this.observations.reset();
    const errors: unknown[] = [];
    for (const close of [
      () => this.#relay.close(),
      () => this.#publicationClient.close(),
      () => this.publication.close(),
      () => this.#consumer.close(),
      () => this.options.toolCommands.close?.(),
      () => this.options.subagentCommands?.close?.(),
      () => this.#retention.close(),
      () => this.eventStore.close(),
      () => this.#topic.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Session Projector cleanup failed");
  }
}
