import { randomUUID } from "node:crypto";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import {
  modelMeteringEventId,
  parseModelBillingPage,
  type ModelMeteringContext,
  type ModelMeteringEvent,
  type ModelRateInput,
  type ModelUsageFact,
} from "@pi-cloud/protocol";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { ModelMeteringService } from "../src/model-metering-service.ts";
import { installModelMeteringIngress } from "../src/http.ts";
import { priceModelUsage, formatModelAmount } from "../src/model-pricing.ts";

const usage: ModelUsageFact = {
  provider: "codex",
  model: "gpt-6-luna",
  serviceTier: "default",
  failed: false,
  quality: "complete",
  unsupportedDimensions: false,
  tokens: {
    input: 60,
    cacheRead: 40,
    cacheWrite: 0,
    output: 20,
    reasoning: 10,
    unclassified: 0,
    total: 130,
  },
};
const definition: Omit<ModelRateInput, "effectiveAt"> = {
  kind: "customer",
  provider: "openai-codex",
  model: "gpt-6-luna",
  serviceTier: "default",
  currency: "USD",
  includeFailed: false,
  perMillion: { input: "1.25", cacheRead: "0.125", cacheWrite: "2.5", output: "5", reasoning: "5" },
};

it("deduplicates reordered/lost-ack deliveries, survives chat deletion, and fixes exact rates at the attempt time", async () => {
  const db = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 6,
  });
  const server = Fastify();
  try {
    await runMigrations(db, "up");
    const service = new ModelMeteringService(db);
    installModelMeteringIngress(server, service, "owned-fixture-key");
    const base = Date.now() + 60_000,
      time = (offset: number) => new Date(base + offset).toISOString();
    const context: ModelMeteringContext = {
      version: 1,
      invocationId: randomUUID(),
      tenantId: randomUUID(),
      sessionId: randomUUID(),
      runId: randomUUID(),
      requestedAt: time(1000),
      provider: "openai-codex",
      model: "gpt-6-luna",
      purpose: "agent",
      conversationId: 7,
      piSessionId: "native-test",
    };
    const first = await service.createRate(context.tenantId, {
      ...definition,
      effectiveAt: time(0),
    });
    const repeated = await Promise.all(
      Array.from({ length: 3 }, () =>
        service.createRate(context.tenantId, { ...definition, effectiveAt: time(0) }),
      ),
    );
    expect(repeated.map((r) => r.id)).toEqual([first.id, first.id, first.id]);
    await expect(
      service.createRate(context.tenantId, {
        ...definition,
        effectiveAt: time(0),
        currency: "CNY",
      }),
    ).rejects.toThrow("different definition");
    const historical = { ...definition, effectiveAt: "2020-01-01T00:00:00.000Z" },
      historicalId = randomUUID();
    await db
      .insertInto("model_rate_versions")
      .values({
        id: historicalId,
        tenant_id: context.tenantId,
        kind: historical.kind,
        provider: historical.provider,
        model: historical.model,
        service_tier: historical.serviceTier,
        effective_at: historical.effectiveAt,
        definition: historical,
        created_at: historical.effectiveAt,
      })
      .execute();
    expect((await service.createRate(context.tenantId, historical)).id).toBe(historicalId);
    const second = await service.createRate(context.tenantId, {
      ...definition,
      effectiveAt: time(2000),
      perMillion: { ...definition.perMillion, input: "2.5" },
    });
    const a = randomUUID(),
      b = randomUUID();
    const events: ModelMeteringEvent[] = [
      { context, kind: "started", occurredAt: context.requestedAt },
      { context, kind: "attempt", executionId: a, occurredAt: time(1000) },
      { context, kind: "usage", executionId: a, occurredAt: time(1000), usage },
      { context, kind: "attempt", executionId: b, occurredAt: time(3000) },
      {
        context,
        kind: "usage",
        executionId: b,
        occurredAt: time(3000),
        usage: { ...usage, failed: true },
      },
      { context, kind: "finished", occurredAt: time(4000), statusCode: 200, cancelled: false },
    ];
    const send = (body: unknown, token = "owned-fixture-key") =>
      server.inject({
        method: "POST",
        url: "/internal/v1/model-metering",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: JSON.stringify(body),
      });
    expect((await send({ events }, "wrong")).statusCode).toBe(401);
    // Completion and usage can arrive before start; response loss retries the same IDs.
    expect((await send({ events: [...events].reverse() })).json()).toEqual({ accepted: 6 });
    await Promise.all([send({ events }), send({ events })]);
    expect(
      (
        await db
          .selectFrom("model_metering_events")
          .selectAll()
          .where("invocation_id", "=", context.invocationId)
          .execute()
      ).length,
    ).toBe(6);
    const query = { from: time(0), to: time(10_000), limit: 50 };
    let page = parseModelBillingPage(await service.list(context.tenantId, query));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.state).toBe("confirmed");
    const prices = page.items[0]!.usage.map((e) => e.valuation.customer);
    expect(prices).toEqual([
      { state: "priced", rateId: first.id, currency: "USD", amountPico: "230000000" },
      { state: "waived", rateId: second.id, currency: "USD", amountPico: "0" },
    ]);
    expect(formatModelAmount("230000000")).toBe("0.000230000000");
    expect(page.items[0]!.usage[0]!.valuation.upstream_estimate.state).toBe("unpriced");
    expect((await service.list(randomUUID(), query)).items).toEqual([]);
    // There are intentionally no FK dependencies on native sessions, Runs or chat rows.
    await db.deleteFrom("sessions").where("id", "=", context.sessionId).execute();
    page = parseModelBillingPage(await service.list(context.tenantId, query));
    expect(page.items[0]!.usage).toHaveLength(2);
    const changed = {
      ...events[2]!,
      usage: { ...usage, tokens: { ...usage.tokens, input: 61, total: 131 } },
    };
    expect((await send({ events: [changed] })).statusCode).toBe(409);
    const unrelated = { ...events[0]!, context: { ...context, invocationId: randomUUID() } };
    expect((await send({ events: [unrelated, changed] })).statusCode).toBe(409);
    expect(
      await db
        .selectFrom("model_invocations")
        .select("id")
        .where("id", "=", unrelated.context.invocationId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      (await send({ events: [{ ...events[0]!, context: { ...context, tenantId: randomUUID() } }] }))
        .statusCode,
    ).toBe(409);
    const broken = { ...events[2]!, usage: { ...usage, tokens: { ...usage.tokens, total: 999 } } };
    expect((await send({ events: [broken] })).statusCode).toBe(400);
    await expect(
      service.createRate(context.tenantId, {
        ...definition,
        effectiveAt: "2000-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("future");
    const row = await db
      .selectFrom("model_metering_events")
      .select("valuation")
      .where("id", "=", modelMeteringEventId(events[2]!))
      .executeTakeFirstOrThrow();
    expect(row.valuation!.customer).toEqual(prices[0]);
  } finally {
    await server.close();
    await db.destroy();
  }
});

it("keeps interrupted/missing usage explicit, separates image tariffs, and paginates without copying fork consumption", async () => {
  const db = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 3,
  });
  try {
    await runMigrations(db, "up");
    const service = new ModelMeteringService(db),
      tenantId = randomUUID();
    const at = new Date().toISOString();
    const context: ModelMeteringContext = {
      version: 1,
      invocationId: randomUUID(),
      tenantId,
      sessionId: randomUUID(),
      runId: randomUUID(),
      requestedAt: at,
      provider: "openai-codex",
      model: "gpt-6-luna",
      purpose: "agent",
    };
    const events: ModelMeteringEvent[] = [
      { context, kind: "started", occurredAt: at },
      { context, kind: "attempt", executionId: randomUUID(), occurredAt: at },
      { context, kind: "interrupted", occurredAt: at },
    ];
    const next = {
      ...context,
      invocationId: randomUUID(),
      runId: randomUUID(),
      sessionId: randomUUID(),
    };
    await service.ingest({
      events: [...events, { context: next, kind: "started", occurredAt: at }],
    });
    const query = { from: "2020-01-01T00:00:00.000Z", to: "2099-01-01T00:00:00.000Z", limit: 1 };
    const first = parseModelBillingPage(await service.list(tenantId, query));
    const last = parseModelBillingPage(
      await service.list(tenantId, { ...query, before: first.next! }),
    );
    expect(first.items[0]!.context.invocationId).not.toBe(last.items[0]!.context.invocationId);
    expect(last.next).toBeNull();
    expect([...first.items, ...last.items].map((r) => r.state).sort()).toEqual([
      "pending",
      "unconfirmed",
    ]);
    expect((await service.list(tenantId, { ...query, sessionId: randomUUID() })).items).toEqual([]);
    expect(priceModelUsage(usage, "image")).toEqual({
      state: "unpriced",
      reason: "unsupported_dimensions",
    });
    expect(priceModelUsage({ ...usage, quality: "unclassified" }, "agent").state).toBe(
      "unconfirmed",
    );
  } finally {
    await db.destroy();
  }
});
