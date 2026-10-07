import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { normalizeCubeUpstreamProxyUrl } from "../../packages/control-plane/src/platform-runtime-settings.ts";

async function writeConfiguration(tx, actor, value, revision) {
  assert(Number.isSafeInteger(revision), "Invalid Cube proxy revision");
  const proxyUrl = value.proxyUrl ?? null;
  await tx
    .updateTable("platform_runtime_settings")
    .set({
      cube_proxy_enabled: value.enabled,
      cube_proxy_url: proxyUrl,
      revision,
      updated_by_tenant_id: actor.tenantId,
      updated_by_user_id: actor.userId,
      updated_at: new Date(),
    })
    .where("settings_key", "=", "default")
    .execute();
  await tx
    .insertInto("platform_runtime_setting_changes")
    .values({
      id: randomUUID(),
      revision,
      actor_tenant_id: actor.tenantId,
      actor_user_id: actor.userId,
      cube_proxy_enabled: value.enabled,
      cube_proxy_url_sha256:
        proxyUrl === null ? null : createHash("sha256").update(proxyUrl).digest("hex"),
      created_at: new Date(),
    })
    .execute();
}

/** Operator-only restoration. The public replace API intentionally has no empty
 * URL sentinel. Restore the original nullable field under a revision CAS and
 * keep the same audit trail; never overwrite a concurrent administrator edit. */
export async function restoreCubeProxyFixture(database, receipt) {
  const { original, installed, actor } = receipt;
  if (!installed) return;
  await database.transaction().execute(async (tx) => {
    const current = await tx
      .selectFrom("platform_runtime_settings")
      .selectAll()
      .where("settings_key", "=", "default")
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (
      current.cube_proxy_enabled === original.enabled &&
      current.cube_proxy_url === (original.proxyUrl ?? null)
    )
      return;
    assert(
      Number(current.revision) === installed.revision &&
        current.cube_proxy_enabled === installed.enabled &&
        current.cube_proxy_url === installed.proxyUrl,
      "Cube proxy changed concurrently; fixture refuses to overwrite it",
    );
    await writeConfiguration(tx, actor, original, Number(current.revision) + 1);
  });
}

export async function withCubeProxyFixture({ api, database, fallbackProxyUrl, saveReceipt }, run) {
  const actor = await api.getIdentity();
  assert(actor.platformAdministrator, "Cube proxy fixture requires the platform operator");
  const original = await api.getCubeProxyConfiguration();
  const receipt = { original, actor: { tenantId: actor.tenantId, userId: actor.userId } };
  if (original.enabled) return run();
  const proxyUrl = normalizeCubeUpstreamProxyUrl(original.proxyUrl ?? fallbackProxyUrl);
  receipt.installed = { enabled: true, proxyUrl, revision: original.revision + 1 };
  // Before mutation, retain enough private evidence to restore after a lost ACK
  // or killed test process using the explicit --restore subcommand.
  await saveReceipt(receipt);
  let failure;
  try {
    await database.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom("platform_runtime_settings")
        .selectAll()
        .where("settings_key", "=", "default")
        .forUpdate()
        .executeTakeFirstOrThrow();
      assert.equal(
        Number(current.revision),
        original.revision,
        "Cube proxy changed during fixture installation",
      );
      await writeConfiguration(tx, actor, receipt.installed, receipt.installed.revision);
    });
    return await run();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await restoreCubeProxyFixture(database, receipt);
    } catch (error) {
      throw new AggregateError(
        [failure, error].filter(Boolean),
        "Cube proxy fixture could not restore configuration; use its private receipt after resolving concurrent edits",
      );
    }
  }
}
