import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PostgresTenantApiAuthenticator,
  TenantAdministrationError,
  createPrivateTenant,
  issuePrivateTenantCredential,
  listPrivateTenantCredentials,
  revokePrivateTenantCredential,
} from "../src/index.ts";

const IDS = [
  "a0000000-0000-4000-8000-000000000001",
  "a0000000-0000-4000-8000-000000000002",
  "a0000000-0000-4000-8000-000000000003",
  "a0000000-0000-4000-8000-000000000004",
  "a0000000-0000-4000-8000-000000000005",
] as const;
const MEMBER_CREDENTIAL_ID = "a0000000-0000-4000-8000-000000000006";
const NOW = new Date("2026-07-19T13:00:00.000Z");

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  await runMigrations(database, "up");
});

const external = process.env.PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL;
it.skipIf(!external)(
  "keeps tenant admission serialized when a smaller tenant ID is inserted",
  async () => {
    const admin = new Pool({ connectionString: external, max: 1 });
    const name = `pi_tenant_admission_${crypto.randomUUID().replaceAll("-", "")}`;
    const clients: Kysely<Database>[] = [];
    const pending: Promise<unknown>[] = [];
    const counted = Promise.withResolvers<void>();
    const continueCount = Promise.withResolvers<void>();
    let blocker: Pool | undefined;
    let created = false;
    try {
      await admin.query(`create database "${name}"`);
      created = true;
      const endpoint = new URL(external!);
      endpoint.pathname = `/${name}`;
      const connect = (application: string) => {
        const url = new URL(endpoint);
        url.searchParams.set("application_name", application);
        const client = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
        clients.push(client);
        return client;
      };
      const observer = connect("tenant-admission-observer");
      await runMigrations(observer, "up");
      await observer.insertInto("tenants").values({ id: IDS[0], slug: "anchor" }).execute();
      blocker = new Pool({ connectionString: endpoint.toString(), max: 1 });
      await blocker.query("begin");
      // Hold both a row and its table's writer lock so either implementation queues.
      await blocker.query("update tenants set slug = slug where id = $1", [IDS[0]]);
      const waiting = async (application: string) => {
        const result = await sql<{ waiting: boolean }>`select exists (
        select 1 from pg_stat_activity
        where application_name = ${application} and wait_event_type = 'Lock'
      ) as waiting`.execute(observer);
        return result.rows[0]!.waiting;
      };
      const request = (client: Kysely<Database>, slug: string, prefix: string) => {
        let id = 0;
        const promise = createPrivateTenant(client, {
          slug,
          ownerDisplayName: slug,
          maximumTenants: 3,
          idGenerator: () => `${prefix}-0000-4000-8000-${String(++id).padStart(12, "0")}`,
        }).then(
          () => "created",
          (error: unknown) => {
            if (error instanceof TenantAdministrationError) return error.code;
            throw error;
          },
        );
        pending.push(promise);
        return promise;
      };
      const first = request(connect("tenant-admission-a"), "first", "00000000");
      await vi.waitFor(async () => expect(await waiting("tenant-admission-a")).toBe(true));
      const secondClient = connect("tenant-admission-b").withPlugin({
        transformQuery: ({ node }) => node,
        async transformResult({ result }) {
          if (result.rows[0]?.["count"] === "2") {
            counted.resolve();
            await continueCount.promise;
          }
          return result;
        },
      });
      const second = request(secondClient, "second", "b0000000");
      await vi.waitFor(async () => expect(await waiting("tenant-admission-b")).toBe(true));
      await blocker.query("commit");
      expect(await first).toBe("created");
      await counted.promise;
      // C starts after A commits the new smallest ID, while B still owns admission.
      let thirdFinished = false;
      const third = request(connect("tenant-admission-c"), "third", "c0000000").finally(() => {
        thirdFinished = true;
      });
      await vi.waitFor(async () =>
        expect(thirdFinished || (await waiting("tenant-admission-c"))).toBe(true),
      );
      continueCount.resolve();
      expect(await Promise.all([second, third])).toEqual(["created", "tenant_capacity_reached"]);
      expect(await observer.selectFrom("tenants").select("id").execute()).toHaveLength(3);
    } finally {
      continueCount.resolve();
      await blocker?.query("rollback");
      await Promise.allSettled(pending);
      await blocker?.end();
      await Promise.all(clients.map((client) => client.destroy()));
      if (created) {
        // pool.end() closes local sockets; wait for PG to observe their exit.
        // FORCE can otherwise send FATAL into a client's still-closing socket.
        await vi.waitFor(
          async () => {
            const remaining = await admin.query(
              "select count(*)::int as count from pg_stat_activity where datname=$1",
              [name],
            );
            expect(remaining.rows[0].count).toBe(0);
          },
          { timeout: 5_000 },
        );
        await admin.query(`drop database "${name}"`);
      }
      await admin.end();
    }
  },
  30_000,
);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("private tenant administration", () => {
  it("atomically creates a tenant, owner, model policy, and one-time credential", async () => {
    let index = 0;
    const created = await createPrivateTenant(database, {
      slug: "engineering-a",
      ownerDisplayName: "Engineering A Owner",
      quotas: {
        maximumProjects: 4,
        maximumSessions: 20,
      },
      idGenerator: () => IDS[index++]!,
      randomSecret: () => "a".repeat(43),
      clock: () => NOW,
    });
    expect(created).toMatchObject({
      tenantId: IDS[0],
      ownerUserId: IDS[1],
      credentialBindingId: IDS[2],
      defaultModelProfileId: IDS[3],
      tenantSlug: "engineering-a",
      credential: { credentialId: IDS[4] },
      quotas: {
        maximumProjects: 4,
        maximumSessions: 20,
      },
    });
    const counts = [];
    counts.push(await database.selectFrom("tenants").selectAll().execute());
    counts.push(await database.selectFrom("users").selectAll().execute());
    counts.push(await database.selectFrom("credential_bindings").selectAll().execute());
    counts.push(await database.selectFrom("model_profiles").selectAll().execute());
    counts.push(await database.selectFrom("tenant_runtime_policies").selectAll().execute());
    counts.push(await database.selectFrom("tenant_api_credentials").selectAll().execute());
    expect(counts.map((rows) => rows.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(counts[4]?.[0]).toMatchObject({ maximum_projects: 4, maximum_sessions: 20 });
    expect(JSON.stringify(counts)).not.toContain(created.credential.token);
    await expect(
      new PostgresTenantApiAuthenticator({ database, clock: () => NOW }).authenticate(
        created.credential.token,
      ),
    ).resolves.toMatchObject({ tenantId: IDS[0], userId: IDS[1], role: "owner" });
  });

  it("fails a duplicate or invalid tenant without leaving partial rows", async () => {
    let index = 0;
    await expect(
      createPrivateTenant(database, {
        slug: "engineering-a",
        ownerDisplayName: "Duplicate",
        idGenerator: () => `b0000000-0000-4000-8000-${String(++index).padStart(12, "0")}`,
        randomSecret: () => "b".repeat(43),
        clock: () => NOW,
      }),
    ).rejects.toBeInstanceOf(TenantAdministrationError);
    expect(await database.selectFrom("tenants").selectAll().execute()).toHaveLength(1);
    expect(await database.selectFrom("users").selectAll().execute()).toHaveLength(1);

    expect(await database.selectFrom("tenants").selectAll().execute()).toHaveLength(1);
  });

  it("issues, lists, and revokes tenant-scoped credentials without listing digests", async () => {
    const issued = await issuePrivateTenantCredential(database, {
      tenant: "engineering-a",
      userId: IDS[1],
      label: "automation member",
      role: "member",
      credentialId: MEMBER_CREDENTIAL_ID,
      randomSecret: () => "m".repeat(43),
      clock: () => NOW,
    });
    const listed = await listPrivateTenantCredentials(database, IDS[0]);
    expect(listed).toHaveLength(2);
    expect(listed[1]).toMatchObject({
      credentialId: MEMBER_CREDENTIAL_ID,
      userId: IDS[1],
      label: "automation member",
      role: "member",
      revokedAt: null,
    });
    expect(JSON.stringify(listed)).not.toContain("secretSha256");
    expect(JSON.stringify(listed)).not.toContain(issued.token);

    expect(
      await revokePrivateTenantCredential(database, {
        tenant: "engineering-a",
        credentialId: MEMBER_CREDENTIAL_ID,
        revokedAt: NOW,
      }),
    ).toBe(true);
    expect(
      await revokePrivateTenantCredential(database, {
        tenant: "engineering-a",
        credentialId: MEMBER_CREDENTIAL_ID,
        revokedAt: NOW,
      }),
    ).toBe(false);
    await expect(
      new PostgresTenantApiAuthenticator({ database, clock: () => NOW }).authenticate(issued.token),
    ).resolves.toBeUndefined();
  });
});
