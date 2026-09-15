import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import {
  createExecutionReference,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  parseEnvironmentValidationReport,
} from "@pi-cloud/protocol";
import type { SandboxHandle } from "../src/sandbox-provider.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresWorkspaceRuntimeStateRepository } from "../src/index.ts";
import { CubePersistentCapsuleCodec } from "../src/cube-persistent-capsule.ts";
import { PostgresToolCommandRoutes } from "../src/tool-command-routes.ts";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

async function fixtureDatabase() {
  const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
  if (endpoint) {
    const name = `pi_compute_${randomUUID().replaceAll("-", "")}`;
    const admin = createDatabase({ connectionString: endpoint, maxConnections: 1 });
    resources.push(async () => {
      await vi.waitFor(
        async () => {
          const remaining = await sql<{
            count: number;
          }>`select count(*)::int as count from pg_stat_activity where datname=${name}`.execute(
            admin,
          );
          expect(remaining.rows[0]?.count).toBe(0);
        },
        { timeout: 5_000 },
      );
      await sql`drop database if exists ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint);
    url.pathname = `/${name}`;
    const database = createDatabase({ connectionString: url.toString(), maxConnections: 4 });
    resources.push(async () => database.destroy());
    await runMigrations(database, "up");
    return database;
  }
  const pglite = await PGlite.create();
  resources.push(async () => pglite.close());
  const socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socket.start();
  resources.push(async () => socket.stop());
  const database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  resources.push(async () => database.destroy());
  await runMigrations(database, "up");
  return database;
}

describe("PostgreSQL Tool Broker ownership", () => {
  it("resolves a Workspace through its Sandbox Domain without ambiguous columns", async () => {
    const database = await fixtureDatabase();

    const tenantId = "20000000-0000-4000-8000-000000000001";
    const projectId = "20000000-0000-4000-8000-000000000002";
    const workspaceId = "20000000-0000-4000-8000-000000000003";
    const userId = "20000000-0000-4000-8000-000000000020";
    await database.insertInto("tenants").values({ id: tenantId, slug: "reservation" }).execute();
    await database
      .insertInto("users")
      .values({ id: userId, tenant_id: tenantId, display_name: "Terminal Owner" })
      .execute();
    await database
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "reservation" })
      .execute();
    await database
      .insertInto("workspaces")
      .values({
        id: workspaceId,
        tenant_id: tenantId,
        project_id: projectId,
        sandbox_domain_id: "sandbox-domain-0001",
        seed_kind: "empty",
      })
      .execute();
    const credentialId = "20000000-0000-4000-8000-000000000010";
    const profileId = "20000000-0000-4000-8000-000000000011";
    const rootSessionId = "20000000-0000-4000-8000-000000000012";
    const childSessionId = "20000000-0000-4000-8000-000000000013";
    const unrelatedSessionId = "20000000-0000-4000-8000-000000000014";
    const forkTurnId = "20000000-0000-4000-8000-000000000015";
    await database
      .insertInto("credential_bindings")
      .values({
        id: credentialId,
        tenant_id: tenantId,
        provider: "test",
        kind: "api_key",
        secret_ref: "test://credential",
        version: 1,
        status: "active",
      })
      .execute();
    await database
      .insertInto("model_profiles")
      .values({
        id: profileId,
        tenant_id: tenantId,
        name: "tree-reservation",
        provider: "test",
        model_id: "test-model",
        default_thinking_level: "off",
        allowed_thinking_levels: ["off"],
        credential_binding_id: credentialId,
        credential_binding_version: 1,
      })
      .execute();
    await database
      .insertInto("sessions")
      .values(
        [rootSessionId, unrelatedSessionId].map((id) => ({
          id,
          pi_session_id: id,
          pi_session_lane: "main",
          tenant_id: tenantId,
          project_id: projectId,
          workspace_id: workspaceId,
          desired_model_profile_id: profileId,
          state: "idle" as const,
        })),
      )
      .execute();
    await database
      .insertInto("turns")
      .values({
        id: forkTurnId,
        tenant_id: tenantId,
        session_id: rootSessionId,
        state: "completed",
        input_kind: "prompt",
        input_text: "seed",
        model_profile_id: profileId,
        provider: "test",
        model_id: "test-model",
        thinking_level: "off",
        credential_binding_id: credentialId,
        credential_binding_version: 1,
        stop_reason: "stop",
        failure_code: null,
        failure_message: null,
        failure_retryable: null,
        started_at: new Date(),
        settled_at: new Date(),
      })
      .execute();
    await database
      .insertInto("sessions")
      .values({
        id: childSessionId,
        pi_session_id: childSessionId,
        pi_session_lane: "main",
        tenant_id: tenantId,
        project_id: projectId,
        workspace_id: workspaceId,
        desired_model_profile_id: profileId,
        state: "idle",

        conversation_parent_session_id: rootSessionId,
        conversation_fork_turn_id: forkTurnId,
        conversation_fork_entry_id: "20000000-0000-4000-8000-000000000016",
      })
      .execute();

    await database
      .insertInto("pi_sessions")
      .values(
        [rootSessionId, childSessionId, unrelatedSessionId].map((id) => ({
          tenant_id: tenantId,
          id,
          created_at_ms: Date.now(),
          parent_session_id: null,
          name: null,
        })),
      )
      .execute();
    const repository = new PostgresWorkspaceRuntimeStateRepository({
      database,
      sandboxDomainId: "sandbox-domain-0001",
      instanceId: "20000000-0000-4000-8000-000000000004",
      ownerBaseUrl: "http://tool-broker-0:4300",
    });
    resources.push(async () => repository.close());
    await repository.start();

    const activationAttemptId = "20000000-0000-4000-8000-000000000008";
    const activation = {
      activationId: "20000000-0000-4000-8000-000000000005",
      assignment: {
        tenantId,
        projectId,
        workspaceId,
        supervisorId: "supervisor-reservation",
        bootId: "20000000-0000-4000-8000-000000000006",
        sandboxId: "20000000-0000-4000-8000-000000000007",
        runId: "20000000-0000-4000-8000-000000000032",
        sessionId: rootSessionId,
        turnId: forkTurnId,
        executionReference: createExecutionReference(
          "20000000-0000-4000-8000-000000000009",
          activationAttemptId,
          1,
        ),
      },
      turnContextSha256: "b".repeat(64),
      attemptContextSha256: "c".repeat(64),
      environmentSha256: "d".repeat(64),
    } as const;
    await database
      .insertInto("sandboxes")
      .values({
        id: activation.assignment.sandboxId,
        supervisor_id: activation.assignment.supervisorId,
        boot_id: activation.assignment.bootId,
        state: "leased",
        max_concurrent_sessions: 1,
        active_sessions: 1,
      })
      .executeTakeFirstOrThrow();
    await expect(
      repository.reserveTerminal({
        terminalId: "20000000-0000-4000-8000-000000000021",
        tenantId,
        userId,
        projectId,
        workspaceId,
        sessionId: rootSessionId,
      }),
    ).resolves.toEqual({
      status: "reserved",
      executionReference: createExecutionReference(
        "20000000-0000-4000-8000-000000000021",
        "20000000-0000-4000-8000-000000000021",
        1,
      ),
    });
    await expect(
      database
        .selectFrom("pi_sessions")
        .select("lease_epoch")
        .where("id", "=", rootSessionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ lease_epoch: "0" });
    await repository.setTerminalState("20000000-0000-4000-8000-000000000021", "released");
    await expect(
      database
        .selectFrom("workspace_terminal_sessions")
        .select("state")
        .where("terminal_id", "=", "20000000-0000-4000-8000-000000000021")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: "released" });

    const delegatedSessionId = "20000000-0000-4000-8000-000000000017";
    const environmentId = "20000000-0000-4000-8000-000000000030";
    const parentRunId = "20000000-0000-4000-8000-000000000032";
    const childTurnId = "20000000-0000-4000-8000-000000000033";
    const childRunId = "20000000-0000-4000-8000-000000000035";
    const childAttemptId = "20000000-0000-4000-8000-000000000037";
    await database
      .insertInto("environment_versions")
      .values({
        id: environmentId,
        tenant_id: tenantId,
        project_id: projectId,
        version_number: 1,
        profile_key: "pi-cloud-fullstack",
        profile_version: "1",
        image_revision: "test",
        spec_sha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
        recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
        recipe_sha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
        state: "validated",
        active: true,
        validated_at: new Date(),
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("sessions")
      .values({
        id: delegatedSessionId,
        pi_session_id: rootSessionId,
        pi_session_lane: "child",
        tenant_id: tenantId,
        project_id: projectId,
        workspace_id: workspaceId,
        desired_model_profile_id: profileId,
        state: "running",
        session_kind: "subagent",
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("turns")
      .values({
        id: childTurnId,
        tenant_id: tenantId,
        session_id: delegatedSessionId,
        state: "running",
        input_kind: "prompt",
        input_text: "Inspect the shared Workspace",
        model_profile_id: profileId,
        provider: "test",
        model_id: "test-model",
        thinking_level: "off",
        credential_binding_id: credentialId,
        credential_binding_version: 1,
        started_at: new Date(),
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("runs")
      .values([
        {
          id: parentRunId,
          tenant_id: tenantId,
          project_id: projectId,
          workspace_id: workspaceId,
          session_id: rootSessionId,
          turn_id: forkTurnId,
          mailbox_position: 1,
          request_sha256: "a".repeat(64),
          available_at: new Date(),
          environment_version_id: environmentId,
          idempotency_key: "delegated-parent",
          state: "running" as const,
          current_attempt_id: null,
          attempt_count: 0,
          started_at: new Date(),
        },
        {
          id: childRunId,
          tenant_id: tenantId,
          project_id: projectId,
          workspace_id: workspaceId,
          session_id: delegatedSessionId,
          turn_id: childTurnId,
          mailbox_position: 1,
          request_sha256: "b".repeat(64),
          available_at: new Date(),
          environment_version_id: environmentId,
          idempotency_key: "delegated-child",
          state: "queued" as const,
          current_attempt_id: null,
          attempt_count: 0,
        },
      ])
      .executeTakeFirstOrThrow();
    await database
      .insertInto("run_attempts")
      .values([
        {
          id: activationAttemptId,
          tenant_id: tenantId,
          run_id: parentRunId,
          attempt_number: 1,
          state: "running" as const,
          claim_owner_id: "supervisor-reservation",
          claim_expires_at: new Date(Date.now() + 60_000),
          running_at: new Date(),
        },
        {
          id: childAttemptId,
          tenant_id: tenantId,
          run_id: childRunId,
          attempt_number: 1,
          state: "running" as const,
          claim_owner_id: "supervisor-reservation",
          claim_expires_at: new Date(Date.now() + 60_000),
          running_at: new Date(),
        },
      ])
      .executeTakeFirstOrThrow();
    await database
      .updateTable("runs")
      .set({ current_attempt_id: activationAttemptId, attempt_count: 1 })
      .where("id", "=", parentRunId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("runs")
      .set({
        state: "running",
        current_attempt_id: childAttemptId,
        attempt_count: 1,
        started_at: new Date(),
      })
      .where("id", "=", childRunId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("run_attempts")
      .set({
        lease_id: "20000000-0000-4000-8000-000000000009",
        sandbox_id: activation.assignment.sandboxId,
        fencing_token: 1,
      })
      .where("id", "in", [activationAttemptId, childAttemptId])
      .execute();
    await database
      .updateTable("run_attempts")
      .set({ native_writer_anchor_id: activationAttemptId })
      .where("id", "=", childAttemptId)
      .execute();
    await database
      .updateTable("pi_sessions")
      .set({ lease_epoch: 1, active_writer_id: activationAttemptId })
      .where("id", "=", rootSessionId)
      .execute();
    await database
      .insertInto("session_leases")
      .values({
        tenant_id: tenantId,
        pi_session_id: rootSessionId,
        lease_id: "20000000-0000-4000-8000-000000000009",
        sandbox_id: activation.assignment.sandboxId,
        writer_id: activationAttemptId,
        fencing_token: 1,
        valid_until: new Date(Date.now() + 60000),
      })
      .execute();
    await database
      .insertInto("subagent_executions")
      .values({
        id: "20000000-0000-4000-8000-000000000036",
        tenant_id: tenantId,
        parent_session_id: rootSessionId,
        parent_run_id: parentRunId,
        parent_attempt_id: activationAttemptId,
        parent_tool_call_id: "subagent-shared",
        root_session_id: rootSessionId,
        root_run_id: parentRunId,
        parent_execution_id: null,
        depth: 1,
        workflow_run_id: "workflow-shared",
        step_index: 0,
        request_sha256: "f".repeat(64),
        child_session_id: delegatedSessionId,
        child_run_id: childRunId,
        agent_name: "cloud-child",
        context_mode: "branch",
        sandbox_mode: "shared",
        state: "queued",
      })
      .executeTakeFirstOrThrow();

    await expect(repository.reserve(activation)).resolves.toEqual({ status: "reserved" });
    await database
      .updateTable("environment_versions")
      .set({ state: "pending", validated_at: null })
      .where("id", "=", environmentId)
      .execute();
    const environment = {
      environmentVersionId: environmentId,
      versionNumber: 1,
      profileKey: "pi-cloud-fullstack" as const,
      profileVersion: "1" as const,
      imageRevision: "test",
      specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630" as const,
      recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
      recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
    };
    const report = parseEnvironmentValidationReport({
      profileKey: environment.profileKey,
      profileVersion: environment.profileVersion,
      imageRevision: environment.imageRevision,
      specSha256: environment.specSha256,
      recipeSha256: environment.recipeSha256,
      isolationBoundary: "microvm",
      runtime: "cubesandbox-kvm",
      networkMode: "public_web_proxy_private_denied",
      runAsUser: "1000:1000",
      readOnlyRootFilesystem: false,
      recipeCommands: [],
      tools: [
        { name: "node", version: "v24.18.0" },
        { name: "java", version: "17.0.19" },
        { name: "python", version: "3.11.2" },
        { name: "git", version: "2.39.5" },
      ],
    });
    const handle: SandboxHandle = {
      providerApiVersion: 1,
      providerId: "cubesandbox",
      activationId: activation.activationId,
      runtimeId: activation.activationId,
      runtimeName: "validation-test",
      workspaceRoot: "/workspace",
      assignment: activation.assignment,
      environment,
      environmentValidation: report,
    };
    await repository.setWorkspaceRuntimeState(activation.activationId, "active", { handle });
    await repository.setWorkspaceRuntimeState(activation.activationId, "active", { handle });
    const reports = await database
      .selectFrom("environment_validations")
      .selectAll()
      .where("environment_version_id", "=", environmentId)
      .execute();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ report, run_id: null, attempt_id: null });
    const childActivation = {
      ...activation,
      assignment: {
        ...activation.assignment,
        runId: childRunId,
        sessionId: delegatedSessionId,
        turnId: childTurnId,
        executionReference: createExecutionReference(
          "20000000-0000-4000-8000-000000000009",
          childAttemptId,
          1,
        ),
      },
      turnContextSha256: "2".repeat(64),
      attemptContextSha256: "3".repeat(64),
    } as const;
    await expect(repository.reserve(childActivation)).resolves.toEqual({ status: "reserved" });
    // Persistent machines can reuse a physical binding ID in later Attempts.
    // Routing must retain exact Attempt/boot identity, not overwrite by VM ID.
    await repository.registerToolBinding(activation.activationId, activation.assignment);
    await repository.registerToolBinding(activation.activationId, childActivation.assignment);
    const routes = new PostgresToolCommandRoutes(database, "sandbox-domain-0001");
    const routeScope = { tenantId, attemptId: activationAttemptId, writerId: activationAttemptId };
    const parentRoutes = await routes.find(routeScope, false);
    expect(parentRoutes).toHaveLength(1);
    expect(parentRoutes[0]!.bindingId).toBe(activation.activationId);
    expect(await routes.isAlive(parentRoutes[0]!.instanceId)).toBe(true);
    expect(await routes.find({ ...routeScope, tenantId: crypto.randomUUID() }, false)).toEqual([]);
    await database
      .updateTable("run_attempts")
      .set({ native_writer_anchor_id: activationAttemptId })
      .where("id", "=", childAttemptId)
      .execute();
    expect(await routes.find(routeScope, true)).toHaveLength(2);
    await expect(
      database
        .selectFrom("tool_broker_workspace_runtimes")
        .select(["workspace_runtime_id", "session_id", "state"])
        .where("workspace_runtime_id", "=", activation.activationId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      workspace_runtime_id: activation.activationId,
      session_id: rootSessionId,
      state: "active",
    });
    await expect(
      repository.beginOperation(
        activation.activationId,
        "20000000-0000-4000-8000-000000000042",
        childActivation.assignment,
        "20000000-0000-4000-8000-000000000041",
        "6".repeat(64),
      ),
    ).resolves.toBe("started");
    await repository.settleOperation("20000000-0000-4000-8000-000000000041", "succeeded");
    await repository.setWorkspaceRuntimeState(activation.activationId, "active");
    await expect(repository.reserve(activation)).resolves.toEqual({ status: "reserved" });
    await expect(
      database
        .selectFrom("tool_broker_workspace_runtimes")
        .select(["session_id", "state"])
        .where("workspace_runtime_id", "=", activation.activationId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      session_id: rootSessionId,
      state: "active",
    });
    await expect(
      repository.beginOperation(
        activation.activationId,
        activation.activationId,
        activation.assignment,
        "20000000-0000-4000-8000-000000000039",
        "4".repeat(64),
      ),
    ).resolves.toBe("started");
    await repository.settleOperation("20000000-0000-4000-8000-000000000039", "succeeded");
    const operationTiming = await database
      .selectFrom("tool_broker_operations")
      .select(["started_at", "settled_at"])
      .where("operation_id", "=", "20000000-0000-4000-8000-000000000039")
      .executeTakeFirstOrThrow();
    expect(operationTiming.settled_at!.valueOf()).toBeGreaterThanOrEqual(
      operationTiming.started_at.valueOf(),
    );
    await database
      .updateTable("runs")
      .set({ compute_session_id: delegatedSessionId })
      .where("id", "=", childRunId)
      .execute();
    const childCompute = {
      ...childActivation,
      activationId: crypto.randomUUID(),
      computeSessionId: delegatedSessionId,
    };
    await expect(repository.reserve(childCompute)).resolves.toEqual({ status: "reserved" });
    await expect(
      repository.reserve({ ...childCompute, computeSessionId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "ownership_lost" });
    await expect(
      repository.beginOperation(
        activation.activationId,
        crypto.randomUUID(),
        childActivation.assignment,
        crypto.randomUUID(),
        "7".repeat(64),
      ),
    ).rejects.toMatchObject({ code: "ownership_lost" });
    await expect(
      repository.beginOperation(
        childCompute.activationId,
        crypto.randomUUID(),
        childActivation.assignment,
        crypto.randomUUID(),
        "8".repeat(64),
      ),
    ).resolves.toBe("started");
    expect(
      await database
        .selectFrom("tool_broker_workspace_runtimes")
        .select("workspace_runtime_id")
        .where("workspace_id", "=", workspaceId)
        .where("state", "in", ["active", "reserved"])
        .execute(),
    ).toHaveLength(2);
    await repository.setWorkspaceRuntimeState(childCompute.activationId, "released");
    await database
      .updateTable("runs")
      .set({ compute_session_id: null })
      .where("id", "=", childRunId)
      .execute();
    await database
      .deleteFrom("session_leases")
      .where("lease_id", "=", "20000000-0000-4000-8000-000000000009")
      .executeTakeFirstOrThrow();
    await expect(
      repository.beginOperation(
        activation.activationId,
        activation.activationId,
        activation.assignment,
        "20000000-0000-4000-8000-000000000040",
        "5".repeat(64),
      ),
    ).rejects.toMatchObject({ code: "ownership_lost" });
    await database
      .updateTable("run_attempts")
      .set({
        state: "failed",
        failure_code: "test_terminal_run",
        failure_message: "test terminal Run",
        failure_retryable: false,
        settled_at: new Date(),
      })
      .where("id", "=", activationAttemptId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("runs")
      .set({
        state: "failed",
        failure_code: "test_terminal_run",
        failure_message: "test terminal Run",
        failure_retryable: false,
        settled_at: new Date(),
      })
      .where("id", "=", parentRunId)
      .executeTakeFirstOrThrow();
    await expect(repository.claimUnboundWorkspaceRuntimes(16)).resolves.toEqual([]);
    await expect(repository.claimUnboundWorkspaceRuntimes(16, 0)).resolves.toEqual([
      expect.objectContaining({ activationId: activation.activationId }),
    ]);
    await expect(
      database
        .selectFrom("tool_broker_workspace_runtimes")
        .select(["state", "failure_code"])
        .where("workspace_runtime_id", "=", activation.activationId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: "cleaning", failure_code: "workspace_runtime_unbound" });
    const machineId = "20000000-0000-4000-8000-000000000050";
    const identity = {
      runtime_id: "20000000-0000-4000-8000-000000000051",
      runtime_name: "surviving-user-machine",
      runtime_capsule: new CubePersistentCapsuleCodec(Buffer.alloc(32, 9)).seal({
        fixture: "surviving-user-machine",
      }),
    };
    await database
      .insertInto("development_environments")
      .values({
        id: machineId,
        tenant_id: tenantId,
        owner_user_id: userId,
        project_id: projectId,
        workspace_id: workspaceId,
        sandbox_domain_id: "sandbox-domain-0001",
        environment_version_id: environmentId,
        owner_instance_id: "20000000-0000-4000-8000-000000000004",
        owner_base_url: "http://tool-broker-0:4300",
        profile_key: "standard",
        cpu_count: 2,
        memory_mib: 4096,
        system_disk_gib: 20,
        ...identity,
        ip_address: null,
        agent_activation_id: activation.activationId,
        state: "running",
        failure_code: null,
        idempotency_key: "test-machine-retention",
        request_sha256: "d".repeat(64),
      })
      .execute();
    await repository.returnDevelopmentEnvironment(machineId, activation.activationId, "unknown", {
      failureCode: "test_transport_failure",
    });
    expect(
      await database
        .selectFrom("development_environments")
        .select(["runtime_id", "runtime_name", "runtime_capsule", "agent_activation_id", "state"])
        .where("id", "=", machineId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ ...identity, agent_activation_id: null, state: "unknown" });
    await repository.setDevelopmentEnvironmentState(machineId, "unknown", {
      failureCode: "persistent_machine_recovery_required",
    });
    expect(
      await database
        .selectFrom("development_environments")
        .select(["runtime_id", "runtime_name", "runtime_capsule"])
        .where("id", "=", machineId)
        .executeTakeFirstOrThrow(),
    ).toEqual(identity);
    await database
      .updateTable("development_environments")
      .set({ runtime_capsule: null, failure_code: "missing_capsule" })
      .where("id", "=", machineId)
      .execute();
    expect(await repository.claimOrphanedDevelopmentEnvironments(16)).toEqual([
      expect.objectContaining({ environmentId: machineId }),
    ]);
    expect(
      await database
        .selectFrom("development_environments")
        .select(["runtime_id", "runtime_name", "state"])
        .where("id", "=", machineId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      runtime_id: identity.runtime_id,
      runtime_name: identity.runtime_name,
      state: "unknown",
    });
    expect(await repository.claimOrphanedDevelopmentEnvironments(16)).toEqual([]);
    await database
      .updateTable("workspace_terminal_sessions")
      .set({ state: "cleaning" })
      .where("terminal_id", "=", "20000000-0000-4000-8000-000000000021")
      .executeTakeFirstOrThrow();
    await repository.close();
    await expect(
      database
        .selectFrom("workspace_terminal_sessions")
        .select(["state", "failure_code"])
        .where("terminal_id", "=", "20000000-0000-4000-8000-000000000021")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: "unknown", failure_code: "tool_broker_stopped" });
  }, 30_000);

  it("fences an expired replica before a surviving owner stays Ready", async () => {
    const database = await fixtureDatabase();

    let now = new Date("2026-08-09T00:00:00.000Z");
    let monotonic = 0;
    const first = new PostgresWorkspaceRuntimeStateRepository({
      database,
      sandboxDomainId: "sandbox-domain-0001",
      instanceId: "10000000-0000-4000-8000-000000000101",
      ownerBaseUrl: "http://tool-broker-0:4300",
      leaseMs: 3_000,
      heartbeatMs: 1_000,
      clock: () => now,
      monotonicNow: () => monotonic,
    });
    resources.push(async () => first.close());
    await first.start();
    await expect(first.checkHealth()).resolves.toBeUndefined();
    expect(() => first.assertLocalOwnership()).not.toThrow();

    now = new Date("2026-08-09T00:00:04.000Z");
    monotonic = 4000;
    expect(() => first.assertLocalOwnership()).toThrowError(
      "Tool Broker locally confirmed ownership lease expired",
    );
    await database
      .updateTable("tool_broker_instances")
      .set({ lease_expires_at: new Date(Date.now() - 1) })
      .where("instance_id", "=", "10000000-0000-4000-8000-000000000101")
      .execute();
    const second = new PostgresWorkspaceRuntimeStateRepository({
      database,
      sandboxDomainId: "sandbox-domain-0001",
      instanceId: "10000000-0000-4000-8000-000000000102",
      ownerBaseUrl: "http://tool-broker-1:4300",
      leaseMs: 3_000,
      heartbeatMs: 1_000,
      clock: () => now,
      monotonicNow: () => monotonic,
    });
    resources.push(async () => second.close());
    await second.start();

    await expect(first.checkHealth()).rejects.toMatchObject({ code: "ownership_lost" });
    await expect(second.checkHealth()).resolves.toBeUndefined();
    expect(() => second.assertLocalOwnership()).not.toThrow();
    await expect(
      database
        .selectFrom("tool_broker_instances")
        .select(["instance_id", "state"])
        .orderBy("instance_id")
        .execute(),
    ).resolves.toEqual([
      { instance_id: "10000000-0000-4000-8000-000000000101", state: "lost" },
      { instance_id: "10000000-0000-4000-8000-000000000102", state: "ready" },
    ]);
  }, 30_000);

  it("waits for the prior same-URL lease instead of crash-looping during replacement", async () => {
    const database = await fixtureDatabase();

    const now = new Date();
    const priorInstanceId = "10000000-0000-4000-8000-000000000201";
    const replacementInstanceId = "10000000-0000-4000-8000-000000000202";
    const ownerBaseUrl = "http://tool-broker:4300/";
    await database
      .insertInto("tool_broker_instances")
      .values({
        instance_id: priorInstanceId,
        sandbox_domain_id: "sandbox-domain-0001",
        owner_base_url: ownerBaseUrl,
        state: "ready",
        lease_expires_at: new Date(now.valueOf() + 60_000),
        last_heartbeat_at: now,
        updated_at: now,
      })
      .executeTakeFirstOrThrow();
    await expect(
      database
        .selectFrom("tool_broker_instances")
        .select(["owner_base_url", "state"])
        .where("sandbox_domain_id", "=", "sandbox-domain-0001")
        .where("owner_base_url", "=", ownerBaseUrl)
        .where("state", "=", "ready")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ owner_base_url: ownerBaseUrl, state: "ready" });
    await database
      .updateTable("tool_broker_instances")
      .set({ lease_expires_at: new Date(Date.now() + 1_000) })
      .where("instance_id", "=", priorInstanceId)
      .executeTakeFirstOrThrow();

    const replacement = new PostgresWorkspaceRuntimeStateRepository({
      database,
      sandboxDomainId: "sandbox-domain-0001",
      instanceId: replacementInstanceId,
      ownerBaseUrl,
      leaseMs: 1_000,
      heartbeatMs: 100,
    });
    resources.push(async () => replacement.close());
    const startedAt = Date.now();
    await expect(replacement.start()).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
    await expect(replacement.checkHealth()).resolves.toBeUndefined();
    await expect(
      database
        .selectFrom("tool_broker_instances")
        .select(["instance_id", "state"])
        .where("instance_id", "=", replacementInstanceId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ instance_id: replacementInstanceId, state: "ready" });
  }, 30_000);
});
