import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";

/** Stop can atomically withdraw sibling queued inputs. Refresh each Run rather
 * than applying cancellation to the pre-Stop snapshot; queued inputs use their
 * revision-checked queue API. Only idempotent cleanup controls are retried. */
export async function settleOwnedAcceptanceRuns(api, sessionId, rows, settled) {
  const terminal = (run) => ["completed", "failed", "cancelled", "timed_out"].includes(run.state);
  for (const row of rows) {
    for (let attempt = 0; ; attempt++) {
      const current = await api.getRun(row.id);
      if (terminal(current)) break;
      try {
        if (current.state === "queued") {
          const queue = await api.getInputQueue(sessionId);
          await api.mutateQueuedInput(
            sessionId,
            row.turn_id,
            { action: "cancel", revision: queue.revision },
            `cleanup:${randomUUID()}`,
          );
        } else {
          await api.cancelTurn(sessionId, row.turn_id, `cleanup:${randomUUID()}`);
        }
        await settled(row.id);
        break;
      } catch (error) {
        if (terminal(await api.getRun(row.id))) break;
        if (attempt >= 2) throw error;
      }
    }
  }
}

/** Only newly created acceptance tenants. Physical deletion must have completed
 * through the product API first; this never deletes a VM or releases quota. */
export async function purgeOwnedAcceptanceTenant(database, tenant, blobs) {
  assert(
    ["release-acceptance-", "native-input-", "cube-check-"].some((prefix) =>
      tenant.tenantSlug.startsWith(prefix),
    ),
    "Not an owned release fixture",
  );
  const row = await database
    .selectFrom("tenants")
    .selectAll()
    .where("id", "=", tenant.tenantId)
    .executeTakeFirstOrThrow();
  assert.equal(row.slug, tenant.tenantSlug, "Acceptance tenant identity changed");
  await database
    .updateTable("tenant_api_credentials")
    .set({ revoked_at: new Date() })
    .where("tenant_id", "=", tenant.tenantId)
    .execute();
  const assertSettled = async (db) => {
    const { rows } = await sql`select
      (select count(*) from sessions where tenant_id=${tenant.tenantId}::uuid)::int as sessions,
      (select count(*) from workspaces where tenant_id=${tenant.tenantId}::uuid and (deleted_at is null or storage_purged_at is null))::int as workspaces,
      (select count(*) from outbox where tenant_id=${tenant.tenantId}::uuid and published_at is null)::int as controls,
      (select count(*) from session_image_references where tenant_id=${tenant.tenantId}::uuid)::int as images,
      (select count(*) from session_image_objects where tenant_id=${tenant.tenantId}::uuid and write_completed_at is null)::int as unfinished_image_writers,
      (select count(*) from session_uploads where tenant_id=${tenant.tenantId}::uuid)::int as uploads`.execute(
      db,
    );
    assert(
      Object.values(rows[0]).every((n) => n === 0),
      "Acceptance resources have not settled/purged",
    );
  };
  await assertSettled(database);
  const { rows: images } =
    await sql`select id from session_image_objects where tenant_id=${tenant.tenantId}::uuid`.execute(
      database,
    );
  for (const image of images)
    await blobs.delete(
      `session-images/${tenant.tenantId}/${image.id}`,
      AbortSignal.timeout(30_000),
    );
  await database.transaction().execute(async (tx) => {
    await assertSettled(tx);
    for (const table of [
      "session_image_objects",
      "outbox",
      "sandbox_http_services",
      "workspace_terminal_sessions",
      "workspace_runtimes",
      "workspace_delete_operations",
      "environment_validations",
      "environment_versions",
      "workspaces",
      "projects",
      "tenant_runtime_policies",
      "tenant_api_credentials",
      "user_password_credentials",
      "web_sessions",
      "model_profiles",
      "credential_bindings",
      "users",
    ])
      await sql`delete from ${sql.table(table)} where tenant_id=${tenant.tenantId}::uuid`.execute(
        tx,
      );
    await tx
      .deleteFrom("tenants")
      .where("id", "=", tenant.tenantId)
      .where("slug", "=", tenant.tenantSlug)
      .execute();
  });
  return { tenantRemoved: true, imagesRemoved: images.length };
}
