import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import {
  createDatabase,
  runMigrations,
  type Database,
  type WorkspaceSeedKind,
} from "@pi-cloud/database";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  createExecutionLease,
  type ExecuteTurnCommandMessage,
} from "@pi-cloud/protocol";
import { parseWorkspaceSeed } from "@pi-cloud/workspace-runtime";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresWorkspaceSeedResolver, WorkspaceSeedError } from "../src/index.ts";

vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

const IDS = {
  tenant: "10000000-0000-4000-8000-000000000001",
  foreignTenant: "10000000-0000-4000-8000-000000000002",
  project: "20000000-0000-4000-8000-000000000001",
  workspace: "30000000-0000-4000-8000-000000000001",
  message: "40000000-0000-4000-8000-000000000001",
  command: "50000000-0000-4000-8000-000000000001",
  session: "60000000-0000-4000-8000-000000000001",
  turn: "70000000-0000-4000-8000-000000000001",
  lease: "80000000-0000-4000-8000-000000000001",
  attempt: "80000000-0000-4000-8000-000000000002",
  profile: "90000000-0000-4000-8000-000000000001",
  credential: "a0000000-0000-4000-8000-000000000001",
  environment: "b0000000-0000-4000-8000-000000000001",
  run: "60000000-0000-4000-8000-000000000001",
} as const;

type Fixture = { database: Kysely<Database>; close(): Promise<void> };
const fixtures: Fixture[] = [];

function command(tenantId: string = IDS.tenant): ExecuteTurnCommandMessage {
  return {
    protocolVersion: 1,
    messageId: IDS.message,
    sentAt: "2026-07-19T00:00:00.000Z",
    type: "command.turn.execute",
    payload: {
      idempotencyKey: "workspace-seed-1",
      tenantId,
      projectId: IDS.project,
      workspaceId: IDS.workspace,
      sessionId: IDS.session,
      piSession: { id: IDS.session, lane: "main" },
      runId: IDS.run,
      turnId: IDS.turn,
      agentId: "root",
      executionLease: createExecutionLease(IDS.lease, IDS.attempt, 1),
      nextEventSeq: 1,
      agent: {
        revisionId: "84041f7b-5052-4abf-8bfd-16adf083c67e",
        definitionKey: "pi-coding",
        runtimeKind: "pi_sdk",
        runtimeVersion: "0.84.1",
        harnessVersion: "pi-cloud-harness-v1",
        sessionStorageKind: "pi_session_storage_v1",
      },
      input: { kind: "prompt", text: "Inspect the Workspace" },
      executionMode: "elastic",
      sandboxProfileKey: "standard",
      workingDirectory: "/workspace",
      toolCapabilities: ["read", "write", "edit", "bash"],
      model: {
        profileId: IDS.profile,
        provider: "pi-cloud-fake",
        modelId: "pi-cloud-fake",
        thinkingLevel: "off",
        serviceTier: null,
        credentialBindingId: IDS.credential,
        credentialBindingVersion: 1,
      },
      environment: {
        environmentVersionId: IDS.environment,
        versionNumber: 1,
        profileKey: "pi-cloud-fullstack",
        profileVersion: "1",
        imageRevision: "development",
        specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
        recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
        recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
      },
    },
  };
}

async function fixture(seedKind: WorkspaceSeedKind): Promise<Fixture> {
  const pglite = await PGlite.create();
  const socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socket.start();
  const database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(database, "up");
  await database
    .insertInto("tenants")
    .values([
      { id: IDS.tenant, slug: "workspace-owner" },
      { id: IDS.foreignTenant, slug: "workspace-foreign" },
    ])
    .execute();
  await database
    .insertInto("projects")
    .values({ id: IDS.project, tenant_id: IDS.tenant, name: "Workspace seed" })
    .execute();
  await database
    .insertInto("workspaces")
    .values({
      id: IDS.workspace,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      sandbox_domain_id: "sandbox-domain-0001",
      seed_kind: seedKind,
    })
    .execute();
  await database
    .insertInto("credential_bindings")
    .values({
      id: IDS.credential,
      tenant_id: IDS.tenant,
      provider: "pi-cloud-fake",
      kind: "brokered",
      secret_ref: "fixture",
      version: 1,
      status: "active",
    })
    .execute();
  await database
    .insertInto("model_profiles")
    .values({
      id: IDS.profile,
      tenant_id: IDS.tenant,
      name: "default",
      provider: "pi-cloud-fake",
      model_id: "pi-cloud-fake",
      default_thinking_level: "off",
      allowed_thinking_levels: ["off"],
      credential_binding_id: IDS.credential,
      credential_binding_version: 1,
    })
    .execute();
  await database
    .insertInto("environment_versions")
    .values({
      id: IDS.environment,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      version_number: 1,
      profile_key: "pi-cloud-fullstack",
      profile_version: "1",
      image_revision: "development",
      spec_sha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
      state: "pending",
      active: true,
      validated_at: null,
    })
    .execute();
  await database
    .insertInto("sessions")
    .values({
      id: IDS.session,
      pi_session_id: IDS.session,
      pi_session_lane: "main",
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      workspace_id: IDS.workspace,
      desired_model_profile_id: IDS.profile,
      state: "running",
    })
    .execute();
  await database
    .insertInto("turns")
    .values({
      id: IDS.turn,
      tenant_id: IDS.tenant,
      session_id: IDS.session,
      state: "running",
      input_kind: "prompt",
      input_text: "Inspect the Workspace",
      model_profile_id: IDS.profile,
      provider: "pi-cloud-fake",
      model_id: "pi-cloud-fake",
      thinking_level: "off",
      credential_binding_id: IDS.credential,
      credential_binding_version: 1,
      started_at: new Date(),
    })
    .execute();
  await database
    .insertInto("runs")
    .values({
      id: IDS.run,
      tenant_id: IDS.tenant,
      project_id: IDS.project,
      workspace_id: IDS.workspace,
      session_id: IDS.session,
      turn_id: IDS.turn,
      mailbox_position: 1,
      request_sha256: "a".repeat(64),
      available_at: new Date(),
      environment_version_id: IDS.environment,
      idempotency_key: "workspace-seed-1",
      state: "queued",
      current_attempt_id: null,
      attempt_count: 0,
    })
    .execute();
  const value = {
    database,
    async close() {
      await database.destroy();
      await socket.stop();
      await pglite.close();
    },
  };
  fixtures.push(value);
  return value;
}

afterEach(async () => Promise.all(fixtures.splice(0).map((value) => value.close())));

describe("PostgreSQL Workspace seed resolver", () => {
  it("materializes an empty Workspace seed", async () => {
    const test = await fixture("empty");
    const bytes = await new PostgresWorkspaceSeedResolver({ database: test.database }).resolve(
      command(),
      new AbortController().signal,
    );
    expect(parseWorkspaceSeed(bytes!)).toEqual([]);
  });

  it("selects the deterministic Java fixture without serializing it into PostgreSQL", async () => {
    const test = await fixture("sample_java");
    await expect(
      new PostgresWorkspaceSeedResolver({ database: test.database }).resolve(
        command(),
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects cross-tenant resolution and cancellation", async () => {
    const test = await fixture("empty");
    const resolver = new PostgresWorkspaceSeedResolver({ database: test.database });
    await expect(
      resolver.resolve(command(IDS.foreignTenant), new AbortController().signal),
    ).rejects.toMatchObject({ code: "workspace_source_unavailable" });
    const controller = new AbortController();
    controller.abort();
    await expect(resolver.resolve(command(), controller.signal)).rejects.toBeInstanceOf(
      WorkspaceSeedError,
    );
  });
});
