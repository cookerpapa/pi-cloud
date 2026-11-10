import type { Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import type { SandboxLifecycleCursor, SandboxLifecyclePage } from "@pi-cloud/protocol";
import type { SandboxLifecycleSource } from "./lifecycle-source.ts";
import { ResourceMeteringService } from "./resource-metering-service.ts";
import { lifecycleInterval, type LifecycleAccountingState } from "./lifecycle-interval.ts";

/** One immutable provider page and accounting cursor commit together. Timers
 * schedule collection only; they never decide a VM's lifetime or create work. */
export class LifecycleCollector {
  readonly #abort = new AbortController();
  readonly #metering: ResourceMeteringService;
  readonly #nodes = new Map<string, { available: boolean; due: number }>();
  readonly #pending = new Map<string, Promise<void>>();
  #discoveredAt = 0;
  #timer: NodeJS.Timeout | undefined;
  #tick: Promise<void> | undefined;
  constructor(
    readonly database: Kysely<Database>,
    readonly source: SandboxLifecycleSource,
  ) {
    this.#metering = new ResourceMeteringService(database);
  }
  start() {
    this.#timer = setInterval(() => {
      if (this.#tick || this.#abort.signal.aborted) return;
      this.#tick = this.tick()
        .catch(() => {})
        .finally(() => {
          this.#tick = undefined;
        });
    }, 5000);
    this.#timer.unref();
  }
  async tick(now = Date.now()) {
    if (now - this.#discoveredAt >= 60_000) {
      const discovered = await this.source.list(this.#abort.signal);
      const known = await this.database
        .selectFrom("resource_lifecycle_sources")
        .select("node_id")
        .where("provider", "=", this.source.id)
        .execute();
      for (const row of known)
        if (!this.#nodes.has(row.node_id))
          this.#nodes.set(row.node_id, { available: false, due: 0 });
      // Preserve missing sources as unavailable; disappearance is not a stop fact.
      for (const node of this.#nodes.values()) node.available = false;
      for (const node of discovered) {
        const existing = this.#nodes.get(node.id);
        this.#nodes.set(node.id, { available: node.available, due: existing?.due ?? 0 });
      }
      this.#discoveredAt = now;
    }
    for (const [id, node] of [...this.#nodes].sort((a, b) => a[1].due - b[1].due)) {
      if (this.#pending.size >= 4) break;
      if (node.due > now || this.#pending.has(id)) continue;
      node.due = now + 60_000;
      const operation = this.collect(id, node.available)
        .then(
          (more) => {
            // Keep catch-up urgent without putting the same busy sources ahead
            // of nodes that have not had their turn yet.
            if (more) node.due = now;
          },
          async () => {
            const failure = await this.database
              .updateTable("resource_lifecycle_sources")
              .set({ failed_at: new Date() })
              .where("id", "=", this.#id(id))
              .where("failed_at", "is", null)
              .returning("id")
              .execute()
              .catch(() => []);
            if (failure.length) process.stderr.write("sandbox_lifecycle_collection_deferred\n");
          },
        )
        .finally(() => this.#pending.delete(id));
      this.#pending.set(id, operation);
    }
    await Promise.allSettled(this.#pending.values());
  }
  #id(node: string) {
    return `${this.source.id}:${node}`;
  }
  async collect(node: string, available = true): Promise<boolean> {
    const id = this.#id(node);
    await this.database
      .insertInto("resource_lifecycle_sources")
      .values({ id, provider: this.source.id, node_id: node })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    if (!available) throw new Error("Lifecycle source is unavailable");
    const until = performance.now() + 4000;
    let more = false;
    do {
      this.#abort.signal.throwIfAborted();
      const checkpoint = await this.database
        .selectFrom("resource_lifecycle_sources")
        .select(["epoch", "after_sequence", "source_position"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      const cursor = checkpoint.epoch
        ? {
            epoch: checkpoint.epoch,
            sequence: String(checkpoint.after_sequence),
            ...(checkpoint.source_position ? { sourcePosition: checkpoint.source_position } : {}),
          }
        : undefined;
      const page = await this.source.read(node, cursor, this.#abort.signal);
      if (!(await this.apply(id, cursor, page))) return true;
      more = page.hasMore;
    } while (more && performance.now() < until);
    return more;
  }
  async apply(
    id: string,
    cursor: SandboxLifecycleCursor | undefined,
    page: SandboxLifecyclePage,
  ): Promise<boolean> {
    return this.database.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom("resource_lifecycle_sources")
        .select(["epoch", "after_sequence", "source_position"])
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        current.epoch !== (cursor?.epoch ?? null) ||
        String(current.after_sequence) !== (cursor?.sequence ?? "0") ||
        current.source_position !== (cursor?.sourcePosition ?? null)
      )
        return false;
      if (
        !page.gap &&
        cursor &&
        page.epoch === cursor.epoch &&
        page.events.length &&
        BigInt(page.events[0]!.sequence) !== BigInt(cursor.sequence) + 1n
      )
        throw new Error("Lifecycle source skipped history without declaring a gap");
      const events = [...page.events].sort(
        (a, b) =>
          a.resource.resourceId.localeCompare(b.resource.resourceId) ||
          (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1),
      );
      for (const event of events) {
        const row = await this.#metering.lockResource(tx, event.resource);
        const previous = row.lifecycle_state as LifecycleAccountingState | undefined;
        const derived = lifecycleInterval(id, page.epoch, event, previous ?? undefined);
        if (derived.receipt) await this.#metering.ingestIn(tx, [derived.receipt]);
        await tx
          .updateTable("resource_metering_resources")
          .set({ lifecycle_state: derived.state })
          .where("id", "=", `compute:${event.resource.resourceId}`)
          .execute();
      }
      await tx
        .updateTable("resource_lifecycle_sources")
        .set({
          epoch: page.epoch,
          after_sequence: page.next,
          source_position: page.sourcePosition ?? null,
          checked_at: new Date(),
          failed_at: null,
          ...(page.gap ? { gap_detected_at: new Date() } : {}),
        })
        .where("id", "=", id)
        .execute();
      return true;
    });
  }
  async close() {
    this.#abort.abort(new Error("Lifecycle collector stopped"));
    clearInterval(this.#timer);
    await this.#tick;
    await Promise.allSettled(this.#pending.values());
    await this.source.close?.();
  }
}
