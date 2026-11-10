import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  parseSandboxLifecyclePage,
  type SandboxLifecycleCursor,
  type SandboxLifecycleEvent,
} from "@pi-cloud/protocol";
import { CubeLifecycleEvents } from "@pi-cloud/sandbox-control/cube-lifecycle";
import type { SandboxLifecycleSource } from "./lifecycle-source.ts";

type Resource = {
  id: string;
  context: SandboxLifecycleEvent["resource"];
  provider_binding: {
    sourceId: string;
    resourceId: string;
    quantity?: SandboxLifecycleEvent["quantity"];
  };
  lifecycle_state: { event?: SandboxLifecycleEvent } | null;
};
type Native = { sandboxID: string; state?: string; cpuCount?: number; memoryMB?: number };

/** Stock Cube supplies best-effort notifications and current observations, not
 * continuous physical history. Register attribution once; sample in bounded PG
 * pages, without adding a provider journal or inventing confirmed charges. */
export class CubeLifecycleSource implements SandboxLifecycleSource {
  readonly id: string;
  readonly #epoch = "cube-native-observations-v1";
  readonly #boot = randomUUID();
  readonly #events: CubeLifecycleEvents;
  #inventory: { at: number; values: Map<string, Native> } | undefined;
  constructor(
    readonly options: {
      id: string;
      url: string;
      apiKey: string;
      database: Kysely<Database>;
      lifecycleRedisUrl?: string;
      lifecycleRedisPassword?: string;
      events?: CubeLifecycleEvents;
      fetch?: typeof fetch;
      clock?: () => number;
    },
  ) {
    this.id = options.id;
    this.#events =
      options.events ??
      new CubeLifecycleEvents({
        ...(options.lifecycleRedisPassword ? { password: options.lifecycleRedisPassword } : {}),
        ...(options.lifecycleRedisUrl ? { url: options.lifecycleRedisUrl } : {}),
      });
  }
  async list(_signal: AbortSignal) {
    return [{ id: "observations", available: true }];
  }
  async #current(signal: AbortSignal) {
    const now = (this.options.clock ?? Date.now)();
    if (this.#inventory && now - this.#inventory.at < 4000) return this.#inventory.values;
    const response = await (this.options.fetch ?? fetch)(
      new URL("/v2/sandboxes?limit=1000", this.options.url),
      {
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        headers: { "X-API-Key": this.options.apiKey },
      },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("Native Cube inventory unavailable");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const part of response.body) {
      bytes += part.length;
      if (bytes > 4 * 1024 * 1024) throw new Error("Native Cube inventory exceeded its bound");
      chunks.push(Buffer.from(part));
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString());
    const rows = Array.isArray(body) ? body : (body as { sandboxes?: unknown })?.sandboxes;
    if (!Array.isArray(rows) || rows.length > 1000)
      throw new Error("Invalid native Cube inventory");
    const values = new Map<string, Native>();
    for (const row of rows) {
      if (!row || typeof row.sandboxID !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(row.sandboxID))
        throw new Error("Invalid native Cube identity");
      values.set(row.sandboxID, row);
    }
    // A bounded list is positive evidence only. Omitted resources stay unknown
    // unless the independent native stream contains an explicit delete.
    this.#inventory = { at: now, values };
    return values;
  }
  async read(id: string, cursor: SandboxLifecycleCursor | undefined, signal: AbortSignal) {
    if (id !== "observations") throw new Error("Unknown native lifecycle source");
    let after = "";
    if (cursor?.sourcePosition && cursor.epoch === this.#epoch) {
      const position = JSON.parse(cursor.sourcePosition) as { after?: unknown };
      if (typeof position.after !== "string" || position.after.length > 256)
        throw new Error("Invalid resource observation cursor");
      after = position.after;
    }
    const { rows } = await sql<Resource>`select id,context,provider_binding,lifecycle_state
      from resource_metering_resources where provider_binding->>'sourceId'=${this.id}
        and id>${after} and (lifecycle_state is null or lifecycle_state->'event'->>'state'<>'absent')
      order by id limit 65`.execute(this.options.database);
    const hasMore = rows.length > 64;
    const inventory = await this.#current(signal);
    const events: SandboxLifecycleEvent[] = [];
    let sequence = BigInt(cursor?.sequence ?? "0");
    const at = new Date((this.options.clock ?? Date.now)()).toISOString();
    for (const row of rows.slice(0, 64)) {
      const native = inventory.get(row.provider_binding.resourceId);
      const previous = row.lifecycle_state?.event;
      let state: SandboxLifecycleEvent["state"] =
        native?.state === "running" || native?.state === "paused" ? native.state : "unknown";
      if (!native && (await this.#events.deletion(row.provider_binding.resourceId)))
        state = "absent";
      const quantity =
        native?.cpuCount && native.memoryMB
          ? {
              kind: "compute" as const,
              cpuMillis: native.cpuCount * 1000,
              memoryBytes: native.memoryMB * 1024 * 1024,
            }
          : (row.provider_binding.quantity ?? previous?.quantity);
      // The directory still retains this unresolved resource. Missing quantity
      // is a collection gap, never zero usage or a made-up default VM size.
      if (!quantity) continue;
      events.push({
        eventId: randomUUID(),
        sequence: String(++sequence),
        previousSequence: previous?.sequence ?? "0",
        resource: row.context,
        quantity,
        incarnation: row.provider_binding.resourceId,
        sourceBootId: this.#boot,
        state,
        observedAt: at,
        occurredAt: null,
        gapReason: "provider_observation",
      });
    }
    return parseSandboxLifecyclePage({
      epoch: this.#epoch,
      low: String(BigInt(cursor?.sequence ?? "0") + 1n),
      high: String(sequence + (hasMore ? 1n : 0n)),
      next: String(sequence),
      gap: true,
      hasMore,
      events,
      sourcePosition: JSON.stringify({
        after: hasMore ? rows[63]!.id : "",
        native: this.#events.position,
      }),
    });
  }
  close() {
    this.#events.close();
  }
}
