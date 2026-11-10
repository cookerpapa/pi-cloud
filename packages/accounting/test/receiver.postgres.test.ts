import { randomUUID } from "node:crypto";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { expect, it } from "vitest";
import { createMeteringApplication } from "../src/http.ts";

it("starts without management, preserves acknowledged receipts across restart, and refuses unavailable PG", async () => {
  const open = () =>
    createDatabase({
      connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
      maxConnections: 2,
      checkoutTimeoutMs: 1000,
    });
  const database = open();
  const replacementDatabase = open();
  const token = "owned-receiver-fixture";
  const first = createMeteringApplication(database, token);
  const replacement = createMeteringApplication(replacementDatabase, token);
  const context = {
    version: 1,
    invocationId: randomUUID(),
    tenantId: randomUUID(),
    sessionId: randomUUID(),
    runId: randomUUID(),
    provider: "openai-codex",
    model: "gpt-6-luna",
    purpose: "agent",
    requestedAt: new Date().toISOString(),
  };
  const request = {
    method: "POST" as const,
    url: "/internal/v1/model-metering",
    headers: { authorization: `Bearer ${token}` },
    payload: { events: [{ context, kind: "started", occurredAt: context.requestedAt }] },
  };
  try {
    // Bootstrap DDL is not a receiver request and must not inherit the deliberately
    // short checkout deadline used below to exercise an unavailable service pool.
    const bootstrap = createDatabase({
      connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
      maxConnections: 1,
      checkoutTimeoutMs: 60000,
    });
    try {
      await runMigrations(bootstrap, "up");
    } finally {
      await bootstrap.destroy();
    }
    expect((await first.inject({ url: "/health/ready" })).statusCode).toBe(200);
    expect((await first.inject(request)).statusCode).toBe(200);
    await first.close();
    await database.destroy();
    // Lost HTTP acknowledgement and receiver replacement both retry the same ID.
    expect((await replacement.inject(request)).statusCode).toBe(200);
    const rows = await replacementDatabase
      .selectFrom("model_metering_events")
      .select("id")
      .where("invocation_id", "=", context.invocationId)
      .execute();
    expect(rows).toHaveLength(1);
    await replacementDatabase.destroy();
    expect((await replacement.inject(request)).statusCode).toBe(503);
    expect((await replacement.inject({ url: "/health/ready" })).statusCode).toBe(503);
    expect((await replacement.inject({ url: "/health/live" })).statusCode).toBe(200);
  } finally {
    await first.close();
    await replacement.close();
    await database.destroy();
    await replacementDatabase.destroy();
  }
});
