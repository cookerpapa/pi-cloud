import { pinRunSkillCatalog } from "@pi-cloud/runtime-core";
import { randomUUID } from "node:crypto";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { SkillMarketService } from "../src/skill-market-service.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import type { SkillImport } from "@pi-cloud/protocol";

const input = (body = "Use the current project conventions."): SkillImport => ({
  label: "1",
  requirements: { tools: [], runtime: "none", software: [] },
  source: {
    kind: "files",
    files: [
      {
        path: "SKILL.md",
        base64: Buffer.from(
          `---\nname: fixture-skill\ndescription: A bounded testing workflow\n---\n${body}`,
        ).toString("base64"),
      },
    ],
  },
});
it("publishes immutable packages, scopes installation and pins versions across concurrent native child use and updates", async () => {
  const db = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 6,
  });
  try {
    await runMigrations(db, "up");
    const tenant = await createPrivateTenant(db, {
      slug: randomUUID(),
      ownerDisplayName: "Skill test",
    });
    const actor = { tenantId: tenant.tenantId, userId: tenant.ownerUserId, role: "owner" as const };
    const bytes = new Map<string, Buffer>();
    let writes = 0,
      loseWrite = false;
    const service = new SkillMarketService({
      database: db,
      blobs: {
        async put(key, body) {
          writes++;
          bytes.set(key, body);
          if (loseWrite) {
            loseWrite = false;
            throw Error("reply lost");
          }
        },
        async *readStream(key) {
          if (!bytes.has(key)) throw Error("not found");
          yield bytes.get(key)!;
        },
      },
    });
    const first = await service.publish(actor, input());
    expect((await service.publish(actor, input())).versionId).toBe(first.versionId);
    const install = await service.install(actor, first.packageId, {
      scope: { kind: "personal" },
      versionId: first.versionId,
      enabled: true,
      revision: null,
    });
    await expect(
      service.install(actor, first.packageId, { ...install, revision: null }),
    ).rejects.toThrow("installation changed");
    const store = new ControlPlaneStore({ database: db, ...tenant });
    const project = await store.createProject({ name: "Skills", source: { kind: "empty" } });
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Skills",
      "elastic",
      { ownerUserId: actor.userId },
    );
    const run = await store.acceptTurn(session.sessionId, "skill-run", {
      prompt: "Inspect the project",
    });
    await pinRunSkillCatalog(db, actor.tenantId, run.runId);
    expect(
      await service.personalInstallationsForRun(actor.tenantId, run.runId, [first.packageId]),
    ).toEqual([
      expect.objectContaining({
        packageId: first.packageId,
        versionId: first.versionId,
        scope: { kind: "personal" },
      }),
    ]);
    expect(
      await service.runActor(actor.tenantId, run.runId, {
        sessionId: session.sessionId,
        conversationId: 1,
      }),
    ).toMatchObject({ userId: actor.userId, role: "member" });
    await expect(
      service.runActor(actor.tenantId, run.runId, { sessionId: randomUUID(), conversationId: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
    const published = await service.inspect(actor.tenantId, actor.userId, "fixture-skill");
    expect(published.skills[0]).toMatchObject({
      owned: true,
      packageId: first.packageId,
      versionId: first.versionId,
    });
    await sql`update skill_versions set runtime_metadata=null where tenant_id=${actor.tenantId}::uuid`.execute(
      db,
    );
    await service.initialize();
    expect((await service.runCatalog(actor.tenantId, run.runId))[0]?.runtimeMetadata).toEqual({
      disableModelInvocation: false,
      requiresWorkspaceFiles: false,
    });
    const beforeWrites = writes;
    const snapshots = await Promise.all([
      service.runCatalog(actor.tenantId, run.runId),
      service.runCatalog(actor.tenantId, run.runId),
    ]);
    expect(snapshots.map((v) => v.map((x) => x.versionId))).toEqual([
      [first.versionId],
      [first.versionId],
    ]);
    expect(writes).toBe(beforeWrites);
    loseWrite = true;
    await expect(
      service.publish(actor, {
        ...input("Updated workflow"),
        packageId: first.packageId,
        label: "2",
      }),
    ).rejects.toThrow("reply lost");
    expect((await service.list(actor)).packages[0]!.versions).toHaveLength(1);
    // An interrupted import from before the metadata migration must be resumable.
    await sql`update skill_versions set runtime_metadata=null where tenant_id=${actor.tenantId}::uuid and not published`.execute(
      db,
    );
    const second = await service.publish(actor, {
      ...input("Updated workflow"),
      packageId: first.packageId,
      label: "2",
    });
    expect(second.runtimeMetadata).toEqual({
      disableModelInvocation: false,
      requiresWorkspaceFiles: false,
    });
    const updated = await service.install(actor, first.packageId, {
      ...install,
      versionId: second.versionId,
    });
    expect((await service.runCatalog(actor.tenantId, run.runId))[0]!.versionId).toBe(
      first.versionId,
    );
    const run2 = await store.acceptTurn(session.sessionId, "skill-run-2", {
      prompt: "Inspect later",
    });
    await pinRunSkillCatalog(db, actor.tenantId, run2.runId);
    expect((await service.runCatalog(actor.tenantId, run2.runId))[0]!.versionId).toBe(
      second.versionId,
    );
    await service.uninstall(actor, first.packageId, updated.scope, updated.revision);
    expect(
      await service.personalInstallationsForRun(actor.tenantId, run.runId, [first.packageId]),
    ).toEqual([]);
    await expect(
      service.uninstall(actor, first.packageId, updated.scope, updated.revision),
    ).resolves.toEqual({ removed: false, absent: true });
    const reinstalled = await service.install(actor, first.packageId, {
      scope: updated.scope,
      versionId: second.versionId,
      enabled: true,
      revision: null,
    });
    expect(BigInt(reinstalled.revision)).toBeGreaterThan(BigInt(updated.revision));
    await expect(
      service.uninstall(actor, first.packageId, updated.scope, updated.revision),
    ).rejects.toThrow("Installation changed");
    await service.uninstall(actor, first.packageId, reinstalled.scope, reinstalled.revision);
    expect((await service.runCatalog(actor.tenantId, run.runId))[0]!.versionId).toBe(
      first.versionId,
    );
    expect((await service.content(actor.tenantId, first.versionId)).files).toEqual(
      input().source.kind === "files" ? (input().source as { files: unknown }).files : [],
    );
    const another = await createPrivateTenant(db, {
      slug: randomUUID(),
      ownerDisplayName: "Other tenant",
    });
    await expect(service.content(another.tenantId, first.versionId)).rejects.toThrow("not found");
    expect(
      (
        await service.list({
          tenantId: another.tenantId,
          userId: another.ownerUserId,
          role: "owner",
        })
      ).packages,
    ).toEqual([]);
    await expect(
      service.install({ ...actor, role: "member" }, first.packageId, {
        scope: { kind: "tenant" },
        versionId: first.versionId,
        enabled: true,
        revision: null,
      }),
    ).rejects.toThrow("owner");
    const shared = await service.install(actor, first.packageId, {
      scope: { kind: "tenant" },
      versionId: first.versionId,
      enabled: true,
      revision: null,
    });
    await service.install(actor, first.packageId, {
      scope: { kind: "project", projectId: project.projectId },
      versionId: first.versionId,
      enabled: false,
      revision: null,
    });
    const run3 = await store.acceptTurn(session.sessionId, "skill-run-3", {
      prompt: "Respect project disable",
    });
    await pinRunSkillCatalog(db, actor.tenantId, run3.runId);
    expect(await service.runCatalog(actor.tenantId, run3.runId)).toEqual([]);
    expect((await service.list(actor, project.projectId)).packages[0]!.installations).toHaveLength(
      2,
    );
    await service.uninstall(actor, first.packageId, shared.scope, shared.revision);
    const inventory = await sql<{
      count: string;
    }>`select count(*) from skill_versions where tenant_id=${actor.tenantId}::uuid`.execute(db);
    expect(inventory.rows[0]!.count).toBe("2");
  } finally {
    await db.destroy();
  }
}, 60000);
