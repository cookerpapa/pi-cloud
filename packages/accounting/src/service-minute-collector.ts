import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import type { ResourceIdentity, ResourceMeteringEvent } from "@pi-cloud/protocol";
import { ResourceMeteringService } from "./resource-metering-service.ts";

type Period = {
  id: string;
  resource_key: string;
  opened_at: Date;
  observed_at: Date;
  ended_at: Date | null;
  settled_through: Date;
  deadline: Date | null;
  context: ResourceIdentity;
  contract: { billing: string; quantity?: ResourceMeteringEvent["quantity"] };
};

/** Stable business identity across uncertain transaction outcomes; not an execution identity. */
function receiptId(period: string, from: number, to: number): string {
  const bytes = createHash("sha256").update(`service-minute-v1:${period}:${from}:${to}`).digest();
  bytes[6] = (bytes[6]! & 15) | 0x50;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** An independent reader of resource-owner service facts. Never changes a VM or its lease. */
export class ServiceMinuteCollector {
  readonly #metering: ResourceMeteringService;
  #timer: NodeJS.Timeout | undefined;
  #pending: Promise<void> | undefined;
  #closed = false;
  constructor(readonly database: Kysely<Database>) {
    this.#metering = new ResourceMeteringService(database);
  }
  start() {
    const run = () => {
      if (this.#closed || this.#pending) return;
      this.#pending = this.tick()
        .catch(() => process.stderr.write("service_minute_settlement_deferred\n"))
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          this.#pending = undefined;
        });
    };
    this.#timer = setInterval(run, 60_000);
    this.#timer.unref();
    run();
  }
  async tick(): Promise<void> {
    const deadline = performance.now() + 4000;
    do {
      const { rows } = await sql<{
        id: string;
        resource_key: string;
      }>`select id,resource_key from compute_service_periods
        where needs_settlement order by updated_at,id limit 64`.execute(this.database);
      if (!rows.length) return;
      let progressed = false;
      for (const row of rows) {
        if (this.#closed) return;
        progressed = (await this.settle(row.id, row.resource_key)) || progressed;
        if (performance.now() >= deadline) return;
      }
      if (!progressed) return;
    } while (performance.now() < deadline && !this.#closed);
  }
  async settle(id: string, resourceKey: string): Promise<boolean> {
    return this.database.transaction().execute(async (tx) => {
      // Match resource-state trigger lock ordering. A busy resource is skipped,
      // never held behind another collector or a resource lifecycle transition.
      const lock =
        await sql`select id from resource_metering_resources where id=${resourceKey} for update skip locked`.execute(
          tx,
        );
      if (!lock.rows.length) return false;
      const { rows } = await sql<Period>`select p.*,r.context,r.service_contract as contract,
        case when p.ended_at is not null then null
          when r.service_contract->>'sourceKind'='workspace' then (select idle_expires_at from workspace_runtimes where workspace_runtime_id=(r.service_contract->>'sourceId')::uuid)
          when r.service_contract->>'sourceKind'='terminal' then (select idle_expires_at from workspace_terminal_sessions where terminal_id=(r.service_contract->>'sourceId')::uuid)
          else null end as deadline
        from compute_service_periods p join resource_metering_resources r on r.id=p.resource_key
        where p.id=${id}::uuid and p.resource_key=${resourceKey} and p.needs_settlement for update of p skip locked`.execute(
        tx,
      );
      const period = rows[0];
      if (!period) return false;
      if (period.contract?.billing !== "platform" || period.contract.quantity?.kind !== "compute") {
        await sql`update compute_service_periods set needs_settlement=false where id=${id}::uuid`.execute(
          tx,
        );
        return true;
      }
      const opened = period.opened_at.getTime(),
        from = period.settled_through.getTime();
      const eligible = Math.min(
        (period.ended_at ?? period.observed_at).getTime(),
        period.deadline?.getTime() ?? Infinity,
      );
      const wholeThrough = opened + Math.max(0, Math.floor((eligible - opened) / 60_000)) * 60_000;
      // Bound catch-up transactions; every interval is a whole number of service
      // minutes. Rate splitting does not round each segment independently.
      const to = Math.min(wholeThrough, from + 16 * 60_000);
      if (to > from) {
        const event: ResourceMeteringEvent = {
          version: 1,
          basis: "platform_service_minute_v1",
          eventId: receiptId(id, from, to),
          resource: period.context,
          sourceId: "platform-service-v1",
          sourceBootId: id,
          incarnation: id,
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          quality: "confirmed",
          state: "running",
          quantity: period.contract.quantity,
        };
        await this.#metering.ingestIn(tx, [event]);
      }
      await sql`update compute_service_periods set settled_through=greatest(settled_through,${new Date(Math.max(from, to))}),
        needs_settlement=${wholeThrough > Math.max(from, to)},updated_at=clock_timestamp() where id=${id}::uuid`.execute(
        tx,
      );
      return true;
    });
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#pending;
  }
}
