import { priceModelUsage } from "./model-pricing.ts";
import { parseModelRateInput, type ModelRate, type ModelValuation } from "@pi-cloud/protocol";
import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  modelMeteringEventId,
  parseModelMeteringBatch,
  type ModelMeteringEvent,
  type ModelMeteringContext,
} from "@pi-cloud/protocol";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export class MeteringConflict extends Error {}

export class ModelMeteringService {
  constructor(readonly database: Kysely<Database>) {}

  async ingest(value: unknown): Promise<{ accepted: number }> {
    const { events } = parseModelMeteringBatch(value);
    await this.database.transaction().execute(async (tx) => {
      const identities = new Map<string, string>();
      // Stable lock order also handles concurrent duplicate batches.
      for (const event of [...events].sort((a, b) =>
        modelMeteringEventId(a).localeCompare(modelMeteringEventId(b)),
      )) {
        const c = event.context;
        const contextHash = hash(c);
        if (identities.has(c.invocationId) && identities.get(c.invocationId) !== contextHash)
          throw new MeteringConflict("Model invocation identity changed");
        if (!identities.has(c.invocationId)) {
          await tx
            .insertInto("model_invocations")
            .values({
              id: c.invocationId,
              tenant_id: c.tenantId,
              session_id: c.sessionId,
              run_id: c.runId,
              requested_at: c.requestedAt,
              provider: c.provider,
              model: c.model,
              purpose: c.purpose,
              context: c,
              context_hash: contextHash,
            })
            .onConflict((oc) => oc.column("id").doNothing())
            .execute();
          const identity = await tx
            .selectFrom("model_invocations")
            .select("context_hash")
            .where("id", "=", c.invocationId)
            .executeTakeFirstOrThrow();
          if (identity.context_hash !== contextHash)
            throw new MeteringConflict("Model invocation identity changed");
          identities.set(c.invocationId, contextHash);
        }
        let valuation: ModelValuation | null = null;
        if (event.kind === "usage") {
          const candidates = await tx
            .selectFrom("model_rate_versions")
            .select(["id", "kind", "definition"])
            .distinctOn("kind")
            .where("tenant_id", "=", c.tenantId)
            .where("provider", "=", c.provider)
            .where("model", "=", event.usage.model)
            .where("service_tier", "=", event.usage.serviceTier)
            .where("effective_at", "<=", new Date(event.occurredAt))
            .orderBy("kind")
            .orderBy("effective_at", "desc")
            .execute();
          const price = (kind: "customer" | "upstream_estimate") => {
            const row = candidates.find((r) => r.kind === kind);
            return priceModelUsage(
              event.usage,
              c.purpose,
              row ? ({ ...row.definition, id: row.id } as ModelRate) : undefined,
            );
          };
          valuation = {
            customer: price("customer"),
            upstream_estimate: price("upstream_estimate"),
          };
        }
        const id = modelMeteringEventId(event),
          payloadHash = hash(event);
        const inserted = await tx
          .insertInto("model_metering_events")
          .values({
            id,
            invocation_id: c.invocationId,
            kind: event.kind,
            execution_id: "executionId" in event ? event.executionId : null,
            occurred_at: event.occurredAt,
            payload: event,
            payload_hash: payloadHash,
            valuation,
          })
          .onConflict((oc) => oc.column("id").doNothing())
          .returning("id")
          .executeTakeFirst();
        if (!inserted) {
          const previous = await tx
            .selectFrom("model_metering_events")
            .select("payload_hash")
            .where("id", "=", id)
            .executeTakeFirstOrThrow();
          if (previous.payload_hash !== payloadHash)
            throw new MeteringConflict("Model receipt identity changed");
        }
      }
    });
    return { accepted: events.length };
  }

  async createRate(tenantId: string, value: unknown) {
    const definition = parseModelRateInput(value);
    return this.database.transaction().execute(async (tx) => {
      const read = () =>
        tx
          .selectFrom("model_rate_versions")
          .select(["id", "definition"])
          .where("tenant_id", "=", tenantId)
          .where("kind", "=", definition.kind)
          .where("provider", "=", definition.provider)
          .where("model", "=", definition.model)
          .where("service_tier", "=", definition.serviceTier)
          .where("effective_at", "=", new Date(definition.effectiveAt))
          .executeTakeFirst();
      const acknowledge = (row: { id: string; definition: Record<string, unknown> }) => {
        if (hash(row.definition) !== hash(definition))
          throw new MeteringConflict("This price version already has a different definition");
        return { id: row.id, ...definition };
      };
      const previous = await read();
      // A lost response can be retried after the effective time. The immutable
      // natural key identifies the already committed version, never a new price.
      if (previous) return acknowledge(previous);
      const now = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tx);
      if (Date.parse(definition.effectiveAt) < now.rows[0]!.now.getTime())
        throw new TypeError(
          "New prices must take effect in the future; recorded amounts are immutable",
        );
      const inserted = await tx
        .insertInto("model_rate_versions")
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          kind: definition.kind,
          provider: definition.provider,
          model: definition.model,
          service_tier: definition.serviceTier,
          effective_at: definition.effectiveAt,
          definition,
        })
        .onConflict((oc) =>
          oc
            .columns(["tenant_id", "kind", "provider", "model", "service_tier", "effective_at"])
            .doNothing(),
        )
        .returning(["id", "definition"])
        .executeTakeFirst();
      return acknowledge(inserted ?? (await read())!);
    });
  }
  async rates(tenantId: string) {
    const rows = await this.database
      .selectFrom("model_rate_versions")
      .select(["id", "definition"])
      .where("tenant_id", "=", tenantId)
      .orderBy("effective_at", "desc")
      .limit(500)
      .execute();
    return rows.map((row) => ({ ...row.definition, id: row.id }) as ModelRate);
  }

  async summary(
    tenantId: string,
    options: { from: string; to: string; sessionId?: string; model?: string },
  ) {
    const result = await sql<{
      kind: string;
      state: string;
      currency: string | null;
      count: string;
      amountPico: string | null;
    }>`
      select p.key as kind, p.value->>'state' as state, p.value->>'currency' as currency,
        count(*)::text as count, sum((p.value->>'amountPico')::numeric)::text as "amountPico"
      from model_invocations i join model_metering_events e on e.invocation_id=i.id
      cross join lateral jsonb_each(e.valuation) p
      where i.tenant_id=${tenantId}::uuid and i.requested_at>=${options.from}::timestamptz and i.requested_at<${options.to}::timestamptz
        ${options.sessionId ? sql`and i.session_id=${options.sessionId}::uuid` : sql``}
        ${options.model ? sql`and i.model=${options.model}` : sql``}
      group by p.key,p.value->>'state',p.value->>'currency'
      order by p.key,p.value->>'state',p.value->>'currency'
    `.execute(this.database);
    return { collectionEnabled: false as const, categories: result.rows };
  }

  async list(
    tenantId: string,
    options: {
      from: string;
      to: string;
      sessionId?: string;
      model?: string;
      before?: { time: string; id: string };
      limit: number;
    },
  ) {
    let q = this.database
      .selectFrom("model_invocations")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("requested_at", ">=", new Date(options.from))
      .where("requested_at", "<", new Date(options.to));
    if (options.sessionId) q = q.where("session_id", "=", options.sessionId);
    if (options.model) q = q.where("model", "=", options.model);
    if (options.before) {
      const cursor = options.before;
      q = q.where((eb) =>
        eb.or([
          eb("requested_at", "<", new Date(cursor.time)),
          eb.and([eb("requested_at", "=", new Date(cursor.time)), eb("id", "<", cursor.id)]),
        ]),
      );
    }
    const rows = await q
      .orderBy("requested_at", "desc")
      .orderBy("id", "desc")
      .limit(options.limit + 1)
      .execute();
    const hasMore = rows.length > options.limit;
    rows.length = Math.min(rows.length, options.limit);
    const facts = rows.length
      ? await this.database
          .selectFrom("model_metering_events")
          .select(["invocation_id", "payload", "valuation"])
          .where(
            "invocation_id",
            "in",
            rows.map((r) => r.id),
          )
          .orderBy("occurred_at")
          .orderBy("id")
          .execute()
      : [];
    const groups = new Map<string, (ModelMeteringEvent & { valuation?: ModelValuation })[]>();
    for (const fact of facts) {
      const group = groups.get(fact.invocation_id) ?? [];
      group.push({
        ...(fact.payload as ModelMeteringEvent),
        ...(fact.valuation ? { valuation: fact.valuation as ModelValuation } : {}),
      });
      groups.set(fact.invocation_id, group);
    }
    const items = rows.map((r) => {
      const events = groups.get(r.id) ?? [];
      const usage = events.filter((e) => e.kind === "usage");
      const missingAttempts = events.filter(
        (e) => e.kind === "attempt" && !usage.some((u) => u.executionId === e.executionId),
      ).length;
      const settled = events.some((e) => e.kind === "finished" || e.kind === "interrupted");
      return {
        context: r.context as ModelMeteringContext,
        state: !settled
          ? "pending"
          : missingAttempts > 0 ||
              !usage.length ||
              usage.some((u) => u.usage.quality !== "complete" || u.usage.tokens.total === 0)
            ? "unconfirmed"
            : "confirmed",
        missingAttempts,
        interrupted: events.some((e) => e.kind === "interrupted"),
        usage,
      };
    });
    const last = rows.at(-1);
    return {
      items,
      next: hasMore && last ? { time: last.requested_at.toISOString(), id: last.id } : null,
    };
  }
}
