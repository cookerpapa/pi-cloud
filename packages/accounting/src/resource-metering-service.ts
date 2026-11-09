import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  parseResourceMeteringBatch,
  parseResourceRateInput,
  type ResourceRate,
  type ResourceMeteringEvent,
  type ResourceIdentity,
  type ResourceBillingItem,
  type ResourceBillingPage,
  type ResourceValuation,
  type ResourceBillingSummary,
  type ResourceStatementPage,
} from "@pi-cloud/protocol";
import { receiptHash, MeteringConflict } from "./receipt-identity.ts";
import { valueResourceReceipt } from "./resource-pricing.ts";

export type ResourceBillingQuery = {
  from: string;
  to: string;
  resourceKind?: "compute" | "workspace";
  workspaceId?: string;
  before?: { time: string; id: string };
  limit: number;
};

export class ResourceMeteringService {
  constructor(readonly database: Kysely<Database>) {}

  async ingest(value: unknown): Promise<{ accepted: number }> {
    const { events } = parseResourceMeteringBatch(value);
    await this.database.transaction().execute((tx) => this.ingestIn(tx, events));
    return { accepted: events.length };
  }

  async lockResource(tx: Transaction<Database>, resource: ResourceIdentity) {
    const key = `${resource.kind}:${resource.resourceId}`,
      contextHash = receiptHash(resource);
    await tx
      .insertInto("resource_metering_resources")
      .values({
        id: key,
        tenant_id: resource.tenantId,
        workspace_id: resource.workspaceId,
        kind: resource.kind,
        resource_id: resource.resourceId,
        context: resource,
        context_hash: contextHash,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    const owner = await tx
      .selectFrom("resource_metering_resources")
      .select(["context_hash", "lifecycle_state"])
      .where("id", "=", key)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (owner.context_hash !== contextHash)
      throw new MeteringConflict("Resource accounting identity changed");
    return owner;
  }

  async ingestIn(tx: Transaction<Database>, events: ResourceMeteringEvent[]): Promise<void> {
    parseResourceMeteringBatch({ events });
    // Each resource row serializes interval admission. Different resources share
    // no lock, and all batches acquire locks in the same order.
    const ordered = [...events].sort(
      (a, b) =>
        `${a.resource.kind}:${a.resource.resourceId}`.localeCompare(
          `${b.resource.kind}:${b.resource.resourceId}`,
        ) ||
        Date.parse(a.from) - Date.parse(b.from) ||
        a.eventId.localeCompare(b.eventId),
    );
    for (const event of ordered) {
      const resource = event.resource,
        key = `${resource.kind}:${resource.resourceId}`;
      await this.lockResource(tx, resource);
      const payloadHash = receiptHash(event);
      const previous = await tx
        .selectFrom("resource_metering_events")
        .select("payload_hash")
        .where("id", "=", event.eventId)
        .executeTakeFirst();
      if (previous) {
        if (previous.payload_hash !== payloadHash)
          throw new MeteringConflict("Resource receipt identity changed");
        continue;
      }
      if (event.quality === "confirmed" && event.from !== event.to) {
        const overlap = await sql<{ id: string }>`select id from resource_metering_events
            where resource_key=${key} and quality='confirmed'
              and tstzrange(from_at,to_at,'[)') && tstzrange(${event.from}::timestamptz,${event.to}::timestamptz,'[)')
            limit 1`.execute(tx);
        if (overlap.rows.length) throw new MeteringConflict("Confirmed resource intervals overlap");
      }
      const rates =
        event.quality === "confirmed"
          ? await sql<{ id: string; definition: Record<string, unknown> }>`
          (select distinct on (kind) id,definition from resource_rate_versions
            where tenant_id=${resource.tenantId}::uuid and resource_kind=${resource.kind}
              and effective_at<=${event.from}::timestamptz order by kind,effective_at desc)
          union all
          (select id,definition from resource_rate_versions
            where tenant_id=${resource.tenantId}::uuid and resource_kind=${resource.kind}
              and effective_at>${event.from}::timestamptz and effective_at<${event.to}::timestamptz)
        `.execute(tx)
          : { rows: [] };
      const valuation = valueResourceReceipt(
        event,
        rates.rows.map((r) => ({ ...r.definition, id: r.id }) as ResourceRate),
      );
      const inserted = await tx
        .insertInto("resource_metering_events")
        .values({
          id: event.eventId,
          resource_key: key,
          tenant_id: resource.tenantId,
          workspace_id: resource.workspaceId,
          resource_kind: resource.kind,
          from_at: event.from,
          to_at: event.to,
          quality: event.quality,
          payload: event,
          payload_hash: payloadHash,
          valuation: sql<ResourceValuation[]>`${JSON.stringify(valuation)}::jsonb`,
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!inserted) {
        const conflict = await tx
          .selectFrom("resource_metering_events")
          .select("payload_hash")
          .where("id", "=", event.eventId)
          .executeTakeFirstOrThrow();
        if (conflict.payload_hash !== payloadHash)
          throw new MeteringConflict("Resource receipt identity changed");
      }
    }
  }

  async createRate(tenantId: string, value: unknown): Promise<ResourceRate> {
    const definition = parseResourceRateInput(value);
    return this.database.transaction().execute(async (tx) => {
      const read = () =>
        tx
          .selectFrom("resource_rate_versions")
          .select(["id", "definition"])
          .where("tenant_id", "=", tenantId)
          .where("kind", "=", definition.kind)
          .where("resource_kind", "=", definition.resourceKind)
          .where("effective_at", "=", new Date(definition.effectiveAt))
          .executeTakeFirst();
      const acknowledge = (row: {
        id: string;
        definition: Record<string, unknown>;
      }): ResourceRate => {
        if (receiptHash(row.definition) !== receiptHash(definition))
          throw new MeteringConflict("Resource price version changed");
        return { id: row.id, ...definition };
      };
      const previous = await read();
      if (previous) return acknowledge(previous);
      const now = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tx);
      if (Date.parse(definition.effectiveAt) < now.rows[0]!.now.getTime())
        throw new TypeError("New prices must take effect in the future");
      const inserted = await tx
        .insertInto("resource_rate_versions")
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          kind: definition.kind,
          resource_kind: definition.resourceKind,
          effective_at: definition.effectiveAt,
          definition,
        })
        .onConflict((oc) =>
          oc.columns(["tenant_id", "kind", "resource_kind", "effective_at"]).doNothing(),
        )
        .returning(["id", "definition"])
        .executeTakeFirst();
      return acknowledge(inserted ?? (await read())!);
    });
  }

  async rates(tenantId: string): Promise<ResourceRate[]> {
    return (
      await this.database
        .selectFrom("resource_rate_versions")
        .select(["id", "definition"])
        .where("tenant_id", "=", tenantId)
        .orderBy("effective_at", "desc")
        .limit(500)
        .execute()
    ).map((row) => ({ ...row.definition, id: row.id }) as ResourceRate);
  }

  async list(tenantId: string, options: ResourceBillingQuery): Promise<ResourceBillingPage> {
    let query = this.database
      .selectFrom("resource_metering_events")
      .select(["id", "from_at", "payload", "valuation"])
      .where("tenant_id", "=", tenantId)
      .where("from_at", ">=", new Date(options.from))
      .where("from_at", "<", new Date(options.to));
    if (options.resourceKind) query = query.where("resource_kind", "=", options.resourceKind);
    if (options.workspaceId) query = query.where("workspace_id", "=", options.workspaceId);
    if (options.before) {
      const before = options.before;
      query = query.where((eb) =>
        eb.or([
          eb("from_at", "<", new Date(before.time)),
          eb.and([eb("from_at", "=", new Date(before.time)), eb("id", "<", before.id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy("from_at", "desc")
      .orderBy("id", "desc")
      .limit(options.limit + 1)
      .execute();
    const hasMore = rows.length > options.limit;
    rows.length = Math.min(rows.length, options.limit);
    const last = rows.at(-1);
    return {
      items: rows.map(
        (row) =>
          ({
            ...row.payload,
            valuation: row.valuation as ResourceValuation[],
          }) as ResourceBillingItem,
      ),
      next: hasMore && last ? { time: last.from_at.toISOString(), id: last.id } : null,
    };
  }

  async summary(tenantId: string, options: ResourceBillingQuery): Promise<ResourceBillingSummary> {
    const rows = await sql<ResourceBillingSummary["categories"][number]>`
      select resource_kind as "resourceKind",p.key as kind,p.value->>'state' as state,
        p.value->>'currency' as currency,count(*)::text as count,
        sum((p.value->>'amountPico')::numeric)::text as "amountPico"
      from resource_metering_events e
      cross join lateral jsonb_array_elements(e.valuation) segment
      cross join lateral jsonb_each(jsonb_build_object('customer',segment->'customer','upstream_estimate',segment->'upstream_estimate')) p
      where tenant_id=${tenantId}::uuid and from_at>=${options.from}::timestamptz and from_at<${options.to}::timestamptz
        ${options.resourceKind ? sql`and resource_kind=${options.resourceKind}` : sql``}
        ${options.workspaceId ? sql`and workspace_id=${options.workspaceId}::uuid` : sql``}
      group by resource_kind,p.key,p.value->>'state',p.value->>'currency'
      order by resource_kind,p.key,p.value->>'state',p.value->>'currency'
    `.execute(this.database);
    return { collectionEnabled: false, categories: rows.rows };
  }

  async statement(
    tenantId: string,
    options: ResourceBillingQuery,
    after?: string,
  ): Promise<ResourceStatementPage> {
    if (after !== undefined && (!after || after.length > 270))
      throw new TypeError("Invalid resource cursor");
    const result = await sql<{
      id: string;
      context: ResourceStatementPage["items"][number]["resource"];
      first_at: Date;
      last_at: Date;
      confirmed: string;
      unconfirmed: string;
      quantity: ResourceStatementPage["items"][number]["quantity"];
      charges: ResourceStatementPage["items"][number]["charges"];
    }>`
      with selected as (
        select r.id,r.context from resource_metering_resources r
        where r.tenant_id=${tenantId}::uuid
          ${options.resourceKind ? sql`and r.kind=${options.resourceKind}` : sql``}
          ${options.workspaceId ? sql`and r.workspace_id=${options.workspaceId}::uuid` : sql``}
          ${after ? sql`and r.id>${after}` : sql``}
          and exists(select 1 from resource_metering_events e where e.resource_key=r.id
            and e.from_at>=${options.from}::timestamptz and e.from_at<${options.to}::timestamptz)
        order by r.id limit ${options.limit + 1}
      ), facts as (
        select e.* from resource_metering_events e join selected s on s.id=e.resource_key
        where e.from_at>=${options.from}::timestamptz and e.from_at<${options.to}::timestamptz
      ), spans as (
        select resource_key,min(from_at) as first_at,max(to_at) as last_at,
          coalesce(sum(extract(epoch from to_at-from_at)*1000) filter(where quality='confirmed'),0)::bigint::text as confirmed,
          coalesce(sum(extract(epoch from to_at-from_at)*1000) filter(where quality='unconfirmed'),0)::bigint::text as unconfirmed
        from facts group by resource_key
      ), latest as (
        select distinct on(resource_key) resource_key,payload->'quantity' as quantity from facts order by resource_key,to_at desc,id desc
      ), charges as (
        select resource_key,p.key as kind,p.value->>'state' as state,p.value->>'currency' as currency,
          count(*)::text as count,sum((p.value->>'amountPico')::numeric)::text as "amountPico"
        from facts cross join lateral jsonb_array_elements(valuation) segment
        cross join lateral jsonb_each(jsonb_build_object('customer',segment->'customer','upstream_estimate',segment->'upstream_estimate')) p
        group by resource_key,p.key,p.value->>'state',p.value->>'currency'
      )
      select s.id,s.context,spans.first_at,spans.last_at,spans.confirmed,spans.unconfirmed,latest.quantity,
        (select jsonb_agg(jsonb_build_object('kind',kind,'state',state,'currency',currency,'count',count,'amountPico',"amountPico") order by kind,state,currency) from charges where resource_key=s.id) as charges
      from selected s join spans on spans.resource_key=s.id join latest on latest.resource_key=s.id order by s.id
    `.execute(this.database);
    const hasMore = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    return {
      items: rows.map((row) => ({
        resource: row.context,
        firstAt: row.first_at.toISOString(),
        lastAt: row.last_at.toISOString(),
        confirmedMilliseconds: row.confirmed,
        unconfirmedMilliseconds: row.unconfirmed,
        quantity: row.quantity,
        charges: row.charges,
      })),
      next: hasMore ? rows.at(-1)!.id : null,
    };
  }
}
