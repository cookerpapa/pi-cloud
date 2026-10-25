import { appendNativeFixture } from "./fixtures/durable-native.ts";
import { readDurableEntries } from "@pi-cloud/pi-session-postgres/durable";
import { sql } from "kysely";
import { emptyEventRuntime } from "./fixtures/event-runtime.ts";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type {
  AcceptedTurnResource,
  ConversationDetailResource,
  ConversationListResource,
  ConversationPruneResource,
  ConversationTreeResource,
  ConversationForkResource,
  ProjectResource,
  SessionResource,
  TenantRegistrationResource,
  WorkspaceListResource,
  WorkspaceDeletionResource,
} from "@pi-cloud/protocol";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresTenantApiAuthenticator,
  ProductionHttpGateway,
  createControlPlaneApplication,
  createPrivateTenant,
  issuePrivateTenantCredential,
} from "../src/index.ts";

const NOW = new Date("2026-07-19T14:00:00.000Z");

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;
let application: NestFastifyApplication;
let http: FastifyInstance;
let alpha: TenantRegistrationResource;
let bravo: TenantRegistrationResource;
let alphaProject: ProjectResource;
let alphaSession: SessionResource;
let alphaTurn: AcceptedTurnResource;
let bravoSession: SessionResource;

function authorization(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function register(tenantSlug: string, displayName: string) {
  return http.inject({
    method: "POST",
    url: "/v1/registrations",
    payload: { tenantSlug, displayName },
  });
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 1,
  });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(database, "up");
  await createPrivateTenant(database, {
    slug: "operator-bootstrap",
    ownerDisplayName: "Operator",
    clock: () => NOW,
  });
  const publicRegistration = {
    enabled: true,
    maximumTenants: 4,
    tenantQuotas: {
      maximumProjects: 2,
      maximumSessions: 8,
    },
    clock: () => NOW,
  } as const;
  application = await createControlPlaneApplication({
    eventRuntime: emptyEventRuntime(),
    database,
    publicRegistration,
    productionHttpGateway: new ProductionHttpGateway({
      authenticator: new PostgresTenantApiAuthenticator({ database, clock: () => NOW }),
      readiness: () => true,
      publicRegistrationEnabled: true,
    }),
    sessionEventStreamOptions: { heartbeatIntervalMs: 20 },
  });
  await application.listen(0, "127.0.0.1");
  http = application.getHttpAdapter().getInstance() as FastifyInstance;
}, 30_000);

afterAll(async () => {
  await application?.close();
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("opt-in registration and tenant conversation discovery", () => {
  it("creates two complete owner identities without authentication or plaintext persistence", async () => {
    const alphaResponse = await register(" Public-Alpha ", " Alpha Owner ");
    expect(alphaResponse.statusCode).toBe(201);
    alpha = alphaResponse.json<TenantRegistrationResource>();
    expect(alpha).toMatchObject({
      tenantSlug: "public-alpha",
      displayName: "Alpha Owner",
      role: "owner",
    });
    expect(alpha.apiToken).toMatch(/^pck_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43,}$/i);
    expect(alphaResponse.body).not.toContain("secretSha256");

    const bravoResponse = await register("public-bravo", "Bravo Owner");
    expect(bravoResponse.statusCode).toBe(201);
    bravo = bravoResponse.json<TenantRegistrationResource>();
    expect(bravo.tenantId).not.toBe(alpha.tenantId);
    expect(bravo.apiToken).not.toBe(alpha.apiToken);

    const persisted = await database
      .selectFrom("tenant_api_credentials")
      .select(["credential_id", "secret_sha256"])
      .where("tenant_id", "in", [alpha.tenantId, bravo.tenantId])
      .execute();
    expect(persisted).toHaveLength(2);
    expect(JSON.stringify(persisted)).not.toContain(alpha.apiToken);
    expect(JSON.stringify(persisted)).not.toContain(bravo.apiToken);

    for (const registration of [alpha, bravo]) {
      const identity = await http.inject({
        method: "GET",
        url: "/v1/identity",
        headers: authorization(registration.apiToken),
      });
      expect(identity.statusCode).toBe(200);
      expect(identity.json()).toMatchObject({
        tenantId: registration.tenantId,
        userId: registration.userId,
        role: "owner",
      });
    }
  });

  it("normalizes validation failures and duplicate slugs without partial rows", async () => {
    const before = await database
      .selectFrom("tenants")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const invalid = await register("bad slug", "Owner");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "invalid_request" } });
    const duplicate = await register("PUBLIC-ALPHA", "Duplicate Owner");
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({
      error: { code: "tenant_slug_unavailable", message: "Tenant slug is unavailable" },
    });
    const after = await database
      .selectFrom("tenants")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect(after.count).toBe(before.count);
    expect(invalid.body).not.toContain("pck_");
    expect(duplicate.body).not.toContain("pck_");
  });

  it("lists and loads only conversations owned by the authenticated tenant", async () => {
    const createAlphaProject = await http.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authorization(alpha.apiToken),
      payload: { name: "Alpha private repair" },
    });
    expect(createAlphaProject.statusCode).toBe(201);
    alphaProject = createAlphaProject.json<ProjectResource>();
    const createAlphaSession = await http.inject({
      method: "POST",
      url: `/v1/projects/${alphaProject.projectId}/sessions`,
      headers: authorization(alpha.apiToken),
      payload: { workspaceId: alphaProject.workspaceId, title: "Test conversation" },
    });
    expect(createAlphaSession.statusCode).toBe(201);
    alphaSession = createAlphaSession.json<SessionResource>();
    const createAlphaTurn = await http.inject({
      method: "POST",
      url: `/v1/sessions/${alphaSession.sessionId}/turns`,
      headers: { ...authorization(alpha.apiToken), "idempotency-key": "alpha-conversation" },
      payload: { prompt: "alpha private prompt" },
    });
    expect(createAlphaTurn.statusCode, createAlphaTurn.body).toBe(202);
    alphaTurn = createAlphaTurn.json<AcceptedTurnResource>();
    const acceptedToolSnapshot = await database
      .selectFrom("runs as run")
      .innerJoin("sessions as session", (join) =>
        join
          .onRef("session.tenant_id", "=", "run.tenant_id")
          .onRef("session.id", "=", "run.session_id"),
      )
      .select([
        "session.tool_capabilities as sessionTools",
        "run.tool_capability_snapshot as runTools",
      ])
      .where("run.id", "=", alphaTurn.runId)
      .executeTakeFirstOrThrow();
    expect(acceptedToolSnapshot).toEqual({
      sessionTools: ["read", "write", "edit", "bash"],
      runTools: ["read", "write", "edit", "bash"],
    });

    const bravoProjectResponse = await http.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authorization(bravo.apiToken),
      payload: { name: "Bravo private repair" },
    });
    expect(bravoProjectResponse.statusCode).toBe(201);
    const bravoProject = bravoProjectResponse.json<ProjectResource>();
    const bravoSessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${bravoProject.projectId}/sessions`,
      headers: authorization(bravo.apiToken),
      payload: { workspaceId: bravoProject.workspaceId, title: "Test conversation" },
    });
    expect(bravoSessionResponse.statusCode).toBe(201);
    bravoSession = bravoSessionResponse.json<SessionResource>();
    expect(
      (
        await http.inject({
          method: "POST",
          url: `/v1/sessions/${bravoSession.sessionId}/turns`,
          headers: {
            ...authorization(bravo.apiToken),
            "idempotency-key": "bravo-conversation",
          },
          payload: { prompt: "bravo private prompt" },
        })
      ).statusCode,
    ).toBe(202);

    const [alphaListResponse, bravoListResponse] = await Promise.all([
      http.inject({
        method: "GET",
        url: "/v1/conversations",
        headers: authorization(alpha.apiToken),
      }),
      http.inject({
        method: "GET",
        url: "/v1/conversations",
        headers: authorization(bravo.apiToken),
      }),
    ]);
    expect(alphaListResponse.statusCode).toBe(200);
    expect(bravoListResponse.statusCode).toBe(200);
    const alphaList = alphaListResponse.json<ConversationListResource>();
    const bravoList = bravoListResponse.json<ConversationListResource>();
    expect(alphaList).toMatchObject({
      truncated: false,
      conversations: [{ sessionId: alphaSession.sessionId, turnCount: 0 }],
    });
    expect(bravoList).toMatchObject({
      truncated: false,
      conversations: [{ sessionId: bravoSession.sessionId, turnCount: 0 }],
    });
    expect(alphaListResponse.body).not.toContain(bravoSession.sessionId);
    expect(bravoListResponse.body).not.toContain(alphaSession.sessionId);

    const alphaDetailResponse = await http.inject({
      method: "GET",
      url: `/v1/conversations/${alphaSession.sessionId}`,
      headers: authorization(alpha.apiToken),
    });
    expect(alphaDetailResponse.statusCode).toBe(200);
    expect(alphaDetailResponse.json<ConversationDetailResource>()).toMatchObject({
      project: {
        projectId: alphaProject.projectId,
        source: { kind: "empty", status: "ready" },
      },
      session: { sessionId: alphaSession.sessionId, state: "cold" },
      turns: [],
      history: { before: null, after: null, hasBefore: false, hasAfter: false },
    });
    const pending = await http.inject({
      method: "GET",
      url: `/v1/sessions/${alphaSession.sessionId}/queued-inputs`,
      headers: authorization(alpha.apiToken),
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({
      items: [
        {
          inputId: alphaTurn.turnId,
          runId: alphaTurn.runId,
          mailboxPosition: 1,
          text: "alpha private prompt",
          status: "queued",
        },
      ],
    });
    const foreignPending = await http.inject({
      method: "GET",
      url: `/v1/sessions/${alphaSession.sessionId}/queued-inputs`,
      headers: authorization(bravo.apiToken),
    });
    expect(foreignPending.statusCode).toBe(404);
    expect(foreignPending.body).not.toContain("alpha private prompt");

    const foreignDetail = await http.inject({
      method: "GET",
      url: `/v1/conversations/${alphaSession.sessionId}`,
      headers: authorization(bravo.apiToken),
    });
    expect(foreignDetail.statusCode).toBe(404);
    expect(foreignDetail.json()).toMatchObject({ error: { code: "not_found" } });
    expect(foreignDetail.body).not.toContain("alpha private prompt");
    const foreignEvents = await http.inject({
      method: "GET",
      url: `/v1/sessions/${alphaSession.sessionId}/events`,
      headers: authorization(bravo.apiToken),
    });
    expect(foreignEvents.statusCode).toBe(404);
    expect(
      (
        await http.inject({
          method: "GET",
          url: "/v1/conversations",
        })
      ).statusCode,
    ).toBe(401);
  });

  it("allows a viewer to read its conversation without granting mutation", async () => {
    const viewerToken = (
      await issuePrivateTenantCredential(database, {
        tenant: alpha.tenantId,
        userId: alpha.userId,
        label: "browser viewer",
        role: "viewer",
        clock: () => NOW,
      })
    ).token;
    expect(
      (
        await http.inject({
          method: "GET",
          url: `/v1/conversations/${alphaSession.sessionId}`,
          headers: authorization(viewerToken),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await http.inject({
          method: "POST",
          url: "/v1/projects",
          headers: authorization(viewerToken),
          payload: { name: "viewer denied" },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("reuses one Workspace across named conversations and deletes only the selected conversation", async () => {
    const secondSessionResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${alphaProject.projectId}/sessions`,
      headers: authorization(alpha.apiToken),
      payload: {
        workspaceId: alphaProject.workspaceId,
        title: "Follow-up in the same workspace",
      },
    });
    expect(secondSessionResponse.statusCode).toBe(201);
    const secondSession = secondSessionResponse.json<SessionResource>();

    const workspacesResponse = await http.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: authorization(alpha.apiToken),
    });
    expect(workspacesResponse.statusCode).toBe(200);
    expect(workspacesResponse.json<WorkspaceListResource>()).toMatchObject({
      truncated: false,
      workspaces: [
        {
          workspaceId: alphaProject.workspaceId,
          projectId: alphaProject.projectId,
          name: "Alpha private repair",
          sessionCount: 2,
        },
      ],
    });

    const deleted = await http.inject({
      method: "DELETE",
      url: `/v1/conversations/${secondSession.sessionId}`,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "delete-alpha-follow-up",
      },
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(
      (
        await http.inject({
          method: "GET",
          url: `/v1/conversations/${secondSession.sessionId}`,
          headers: authorization(alpha.apiToken),
        })
      ).statusCode,
    ).toBe(404);

    const remaining = await http.inject({
      method: "GET",
      url: "/v1/conversations",
      headers: authorization(alpha.apiToken),
    });
    expect(remaining.json<ConversationListResource>().conversations).toEqual([
      expect.objectContaining({
        sessionId: alphaSession.sessionId,
        title: "Test conversation",
        workspaceName: "Alpha private repair",
      }),
    ]);
    const workspacesAfterDelete = await http.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: authorization(alpha.apiToken),
    });
    expect(workspacesAfterDelete.json<WorkspaceListResource>().workspaces[0]).toMatchObject({
      workspaceId: alphaProject.workspaceId,
      sessionCount: 1,
    });
  });

  it("rejects exclusive mode on elastic storage and preserves a Session across Workspace deletion", async () => {
    const projectResponse = await http.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authorization(alpha.apiToken),
      payload: { name: "Persistent devbox" },
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json<ProjectResource>();

    const persistentResponse = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      headers: authorization(alpha.apiToken),
      payload: {
        workspaceId: project.workspaceId,
        title: "Long-running development environment",
        executionMode: "development_environment",
      },
    });
    expect(persistentResponse.statusCode).toBe(409);

    const replacement = await http.inject({
      method: "POST",
      url: `/v1/projects/${project.projectId}/sessions`,
      headers: authorization(alpha.apiToken),
      payload: {
        workspaceId: project.workspaceId,
        title: "Replacement conversation",
        executionMode: "elastic",
      },
    });
    expect(replacement.statusCode).toBe(201);
    const replacementSession = replacement.json<SessionResource>();
    expect(replacementSession.executionMode).toBe("elastic");

    const deletionHeaders = {
      ...authorization(alpha.apiToken),
      "idempotency-key": "delete-live-persistent-workspace",
    };
    await pglite.exec("alter table workspace_terminal_sessions disable trigger all");
    await database
      .insertInto("workspace_terminal_sessions")
      .values({
        terminal_id: "90000000-0000-4000-8000-000000000001",
        sandbox_domain_id: "sandbox-domain-0001",
        owner_instance_id: "90000000-0000-4000-8000-000000000002",
        owner_base_url: "http://terminal-owner.invalid",
        tenant_id: alpha.tenantId,
        user_id: alpha.userId,
        project_id: project.projectId,
        workspace_id: project.workspaceId,
        session_id: replacementSession.sessionId,
        fencing_token: 1,
        runtime_id: "workspace-terminal-runtime",
        runtime_name: "workspace-terminal-runtime",
        state: "active",
        failure_code: null,
      })
      .executeTakeFirstOrThrow();
    await pglite.exec("alter table workspace_terminal_sessions enable trigger all");
    const blockedByTerminal = await http.inject({
      method: "DELETE",
      url: `/v1/workspaces/${project.workspaceId}`,
      headers: deletionHeaders,
    });
    expect(blockedByTerminal.statusCode).toBe(409);
    await database
      .updateTable("workspace_terminal_sessions")
      .set({ state: "released" })
      .where("terminal_id", "=", "90000000-0000-4000-8000-000000000001")
      .executeTakeFirstOrThrow();
    const deletedWorkspace = await http.inject({
      method: "DELETE",
      url: `/v1/workspaces/${project.workspaceId}`,
      headers: deletionHeaders,
    });
    expect(deletedWorkspace.statusCode).toBe(200);
    const deletion = deletedWorkspace.json<WorkspaceDeletionResource>();
    expect(deletion).toMatchObject({
      workspaceId: project.workspaceId,
      storageState: "pending",
      detachedSessionCount: 1,
      replayed: false,
    });

    const detachedConversation = await http.inject({
      method: "GET",
      url: `/v1/conversations/${replacementSession.sessionId}`,
      headers: authorization(alpha.apiToken),
    });
    expect(detachedConversation.statusCode).toBe(200);
    expect(detachedConversation.json<ConversationDetailResource>().session.workspaceState).toBe(
      "missing",
    );
    const rejectedTurn = await http.inject({
      method: "POST",
      url: `/v1/sessions/${replacementSession.sessionId}/turns`,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "detached-turn",
      },
      payload: { prompt: "continue", thinkingLevel: "off" },
    });
    expect(rejectedTurn.statusCode).toBe(409);

    const rebound = await http.inject({
      method: "PUT",
      url: `/v1/conversations/${replacementSession.sessionId}/workspace`,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "rebind-detached-conversation",
      },
      payload: { workspaceId: alphaProject.workspaceId },
    });
    expect(rebound.statusCode).toBe(200);
    expect(rebound.json()).toMatchObject({
      sessionId: replacementSession.sessionId,
      workspaceId: alphaProject.workspaceId,
      workspaceState: "attached",
      replayed: false,
    });
    expect(
      (
        await http.inject({
          method: "GET",
          url: `/v1/conversations/${replacementSession.sessionId}`,
          headers: authorization(alpha.apiToken),
        })
      ).json<ConversationDetailResource>().session.workspaceState,
    ).toBe("attached");

    const foreignDeletion = await http.inject({
      method: "DELETE",
      url: `/v1/workspaces/${project.workspaceId}`,
      headers: {
        ...authorization(bravo.apiToken),
        "idempotency-key": "delete-foreign-workspace",
      },
    });
    expect(foreignDeletion.statusCode).toBe(404);

    const replay = await http.inject({
      method: "DELETE",
      url: `/v1/workspaces/${project.workspaceId}`,
      headers: deletionHeaders,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<WorkspaceDeletionResource>()).toMatchObject({
      operationId: deletion.operationId,
      workspaceId: project.workspaceId,
      replayed: true,
    });

    const visibleWorkspaces = await http.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: authorization(alpha.apiToken),
    });
    expect(
      visibleWorkspaces
        .json<WorkspaceListResource>()
        .workspaces.some((workspace) => workspace.workspaceId === project.workspaceId),
    ).toBe(false);
    expect(
      (
        await http.inject({
          method: "POST",
          url: `/v1/projects/${project.projectId}/sessions`,
          headers: authorization(alpha.apiToken),
          payload: { workspaceId: project.workspaceId, title: "Cannot restore deleted files" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("forks a settled Pi branch transactionally and renders inherited history", async () => {
    const userEntryId = "2";
    const assistantEntryId = "3";
    await database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("runs")
        .set({ state: "completed", stop_reason: "stop", settled_at: NOW })
        .where("tenant_id", "=", alpha.tenantId)
        .where("turn_id", "=", alphaTurn.turnId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("runs")
        .set({ state: "completed", stop_reason: "stop", settled_at: NOW })
        .where("tenant_id", "=", alpha.tenantId)
        .where("id", "=", alphaTurn.runId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("sessions")
        .set({ state: "idle" })
        .where("tenant_id", "=", alpha.tenantId)
        .where("id", "=", alphaSession.sessionId)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("session_terminal_events")
        .values({
          event_id: globalThis.crypto.randomUUID(),
          tenant_id: alpha.tenantId,
          session_id: alphaSession.sessionId,
          turn_id: alphaTurn.turnId,
          agent_id: "root",
          run_id: alphaTurn.runId,
          seq: 1,
          schema_version: 1,
          type: "turn.completed",
          payload: { stopReason: "stop" },
          occurred_at: NOW,
        })
        .executeTakeFirstOrThrow();
      await appendNativeFixture(
        transaction,
        {
          tenantId: alpha.tenantId,
          sessionId: alphaSession.sessionId,
          turnId: alphaTurn.turnId,
          runId: alphaTurn.runId,
        },
        [
          {
            id: Number(userEntryId),
            kind: "pi.user",
            model: [{ role: "user", content: "alpha private prompt", timestamp: NOW.valueOf() }],
          },
          {
            id: Number(assistantEntryId),
            kind: "pi.assistant",
            model: [
              {
                role: "assistant",
                content: [{ type: "text", text: "alpha final answer" }],
                api: "test",
                provider: "test",
                model: "test",
                stopReason: "stop",
                timestamp: NOW.valueOf() + 1,
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
              },
            ],
          },
        ],
      );
    });

    const beforeFork = await http.inject({
      method: "GET",
      url: `/v1/conversations/${alphaSession.sessionId}/tree?view=full`,
      headers: authorization(alpha.apiToken),
    });
    expect(beforeFork.statusCode).toBe(200);
    expect(beforeFork.json<ConversationTreeResource>()).toMatchObject({
      rootSessionId: alphaSession.sessionId,
      currentSessionId: alphaSession.sessionId,
      view: "full",
      branches: [
        {
          sessionId: alphaSession.sessionId,
          current: true,
          entries: [
            { role: "user", turnId: alphaTurn.turnId },
            {
              role: "assistant",
              turnId: alphaTurn.turnId,
              entryId: assistantEntryId,
              finalAssistant: true,
            },
          ],
        },
      ],
    });

    const forkRequest = {
      method: "POST" as const,
      url: `/v1/conversations/${alphaSession.sessionId}/forks`,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "fork-alpha-final",
      },
      payload: {
        turnId: alphaTurn.turnId,
        entryId: assistantEntryId,
        title: "Alternative alpha branch",
      },
    };
    const forkResponse = await http.inject(forkRequest);
    expect(forkResponse.statusCode).toBe(201);
    const forked = forkResponse.json<ConversationForkResource>();
    expect(forked).toMatchObject({
      parentSessionId: alphaSession.sessionId,
      forkedFromTurnId: alphaTurn.turnId,
      forkedFromEntryId: assistantEntryId,
      replayed: false,
      session: {
        title: "Alternative alpha branch",
        workspaceId: alphaProject.workspaceId,
      },
    });
    const replay = await http.inject(forkRequest);
    expect(replay.statusCode).toBe(201);
    expect(replay.json<ConversationForkResource>()).toMatchObject({
      replayed: true,
      session: { sessionId: forked.session.sessionId },
    });

    const childDetail = await http.inject({
      method: "GET",
      url: `/v1/conversations/${forked.session.sessionId}`,
      headers: authorization(alpha.apiToken),
    });
    expect(childDetail.statusCode).toBe(200);
    expect(childDetail.json<ConversationDetailResource>()).toMatchObject({
      session: {
        sessionId: forked.session.sessionId,
        parentSessionId: alphaSession.sessionId,
      },
      turns: [{ turnId: alphaTurn.turnId, originSessionId: alphaSession.sessionId }],
    });
    const fullTree = await http.inject({
      method: "GET",
      url: `/v1/conversations/${forked.session.sessionId}/tree?view=full`,
      headers: authorization(alpha.apiToken),
    });
    expect(fullTree.json<ConversationTreeResource>().branches).toEqual([
      expect.objectContaining({ sessionId: alphaSession.sessionId, current: false }),
      expect.objectContaining({
        sessionId: forked.session.sessionId,
        parentSessionId: alphaSession.sessionId,
        forkedFromEntryId: assistantEntryId,
        current: true,
      }),
    ]);
    const copiedEntries = (
      await readDurableEntries(database, {
        tenantId: alpha.tenantId,
        sessionId: forked.session.sessionId,
        conversationId: 1,
        limit: 10,
      })
    ).reverse();
    expect(copiedEntries.map((row) => String(row.entry.id))).toEqual([
      userEntryId,
      assistantEntryId,
    ]);
    expect(
      (
        await sql<{
          kind: string;
        }>`select record_kind as kind from pi_durable_log where tenant_id=${alpha.tenantId}::uuid
      and session_id=${forked.session.sessionId} order by seq,ordinal`.execute(database)
      ).rows,
    ).toEqual([{ kind: "conversation" }, { kind: "entry" }, { kind: "entry" }]);
    const foreignTree = await http.inject({
      method: "GET",
      url: `/v1/conversations/${forked.session.sessionId}/tree`,
      headers: authorization(bravo.apiToken),
    });
    expect(foreignTree.statusCode).toBe(404);

    const laterTurnResponse = await http.inject({
      method: "POST",
      url: `/v1/sessions/${alphaSession.sessionId}/turns`,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "alpha-later-turn",
      },
      payload: { prompt: "later branch that should be pruned" },
    });
    expect(laterTurnResponse.statusCode).toBe(202);
    const laterTurn = laterTurnResponse.json<AcceptedTurnResource>();
    const laterUserEntryId = "4";
    const laterAssistantEntryId = "5";
    await database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("runs")
        .set({ state: "completed", stop_reason: "stop", settled_at: NOW })
        .where("tenant_id", "=", alpha.tenantId)
        .where("turn_id", "=", laterTurn.turnId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("runs")
        .set({ state: "completed", stop_reason: "stop", settled_at: NOW })
        .where("tenant_id", "=", alpha.tenantId)
        .where("id", "=", laterTurn.runId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("sessions")
        .set({ state: "idle" })
        .where("tenant_id", "=", alpha.tenantId)
        .where("id", "=", alphaSession.sessionId)
        .executeTakeFirstOrThrow();
      const laterEntries = [
        {
          id: laterUserEntryId,
          seq: 3,
          parentId: assistantEntryId,
          timestamp: NOW.valueOf() + 2,
          message: {
            role: "user",
            content: "later branch that should be pruned",
            timestamp: NOW.valueOf() + 2,
          },
        },
        {
          id: laterAssistantEntryId,
          seq: 4,
          parentId: laterUserEntryId,
          timestamp: NOW.valueOf() + 3,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "later answer" }],
            provider: "test",
            model: "test",
            api: "test",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: NOW.valueOf() + 3,
          },
        },
      ];
      await appendNativeFixture(
        transaction,
        {
          tenantId: alpha.tenantId,
          sessionId: alphaSession.sessionId,
          turnId: laterTurn.turnId,
          runId: laterTurn.runId,
        },
        laterEntries.map((entry) => ({
          id: Number(entry.id),
          kind: entry.message.role === "user" ? "pi.user" : "pi.assistant",
          model: [entry.message],
        })),
      );
    });

    const pruneRequest = {
      method: "POST" as const,
      url: `/v1/conversations/${alphaSession.sessionId}/prunes`,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "prune-alpha-after-first-answer",
      },
      payload: { turnId: alphaTurn.turnId, entryId: assistantEntryId },
    };
    const prunedResponse = await http.inject(pruneRequest);
    expect(prunedResponse.statusCode).toBe(201);
    expect(prunedResponse.json<ConversationPruneResource>()).toMatchObject({
      anchorTurnId: alphaTurn.turnId,
      anchorEntryId: assistantEntryId,
      prunedTurnCount: 1,
      prunedSessionCount: 1,
      replayed: false,
    });
    expect((await http.inject(pruneRequest)).json<ConversationPruneResource>()).toMatchObject({
      replayed: true,
    });
    expect(
      await database
        .selectFrom("runs")
        .select("pruned_at as prunedAt")
        .where("turn_id", "=", laterTurn.turnId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ prunedAt: expect.anything() });
    const nativeBinding = await database
      .selectFrom("sessions")
      .select("pi_conversation_id")
      .where("id", "=", alphaSession.sessionId)
      .executeTakeFirstOrThrow();
    const activeNative = await readDurableEntries(database, {
      tenantId: alpha.tenantId,
      sessionId: alphaSession.sessionId,
      conversationId: Number(nativeBinding.pi_conversation_id),
      limit: 1,
    });
    expect(String(activeNative[0]?.entry.id)).toBe(assistantEntryId);
    expect(
      await database
        .selectFrom("sessions")
        .select("pruned_at as prunedAt")
        .where("id", "=", forked.session.sessionId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ prunedAt: expect.anything() });
    const afterPruneTree = await http.inject({
      method: "GET",
      url: `/v1/conversations/${alphaSession.sessionId}/tree?view=full`,
      headers: authorization(alpha.apiToken),
    });
    expect(afterPruneTree.json<ConversationTreeResource>()).toMatchObject({
      branches: [
        {
          sessionId: alphaSession.sessionId,
          entries: [
            { turnId: alphaTurn.turnId, role: "user" },
            { turnId: alphaTurn.turnId, role: "assistant" },
          ],
        },
      ],
    });

    const replacementFork = await http.inject({
      ...forkRequest,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "fork-alpha-before-subtree-delete",
      },
      payload: {
        turnId: alphaTurn.turnId,
        entryId: assistantEntryId,
        title: "Child removed with parent",
      },
    });
    expect(replacementFork.statusCode).toBe(201);
    const replacementChildId = replacementFork.json<ConversationForkResource>().session.sessionId;
    const deletedTree = await http.inject({
      method: "DELETE",
      url: `/v1/conversations/${alphaSession.sessionId}`,
      headers: {
        ...authorization(alpha.apiToken),
        "idempotency-key": "delete-alpha-conversation-tree",
      },
    });
    expect(deletedTree.statusCode, deletedTree.body).toBe(204);
    expect(
      await database
        .selectFrom("sessions")
        .select(["id", "pruned_at as prunedAt"])
        .where("id", "in", [alphaSession.sessionId, replacementChildId])
        .orderBy("id")
        .execute(),
    ).toEqual([]);
  });

  it("pages conversation history by a tenant-scoped Turn anchor", async () => {
    const created = await http.inject({
      method: "POST",
      url: `/v1/projects/${alphaProject.projectId}/sessions`,
      headers: authorization(alpha.apiToken),
      payload: { workspaceId: alphaProject.workspaceId, title: "History pages" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const session = created.json<SessionResource>();
    const ids: string[] = [];
    for (let i = 0; i < 45; i++) {
      const accepted = await http.inject({
        method: "POST",
        url: `/v1/sessions/${session.sessionId}/turns`,
        headers: { ...authorization(alpha.apiToken), "idempotency-key": `page-${i}` },
        payload: { prompt: `page prompt ${i}` },
      });
      expect(accepted.statusCode, accepted.body).toBe(202);
      ids.push(accepted.json<AcceptedTurnResource>().turnId);
      await database
        .updateTable("runs")
        .set({
          state: "completed",
          ready_at: null,
          started_at: new Date(),
          settled_at: new Date(),
          stop_reason: "stop",
        })
        .where("id", "=", accepted.json<AcceptedTurnResource>().runId)
        .execute();
    }
    // This read-model fixture represents finished history. Unstarted inputs
    // have their own queue endpoint and do not consume history page positions.
    const settled = new Date();
    await database.transaction().execute(async (tx) => {
      await tx
        .updateTable("runs")
        .set({
          state: "completed",
          ready_at: null,
          started_at: settled,
          settled_at: settled,
          stop_reason: "stop",
        })
        .where("tenant_id", "=", alpha.tenantId)
        .where("session_id", "=", session.sessionId)
        .execute();
      await tx
        .updateTable("runs")
        .set({ state: "completed", started_at: settled, settled_at: settled, stop_reason: "stop" })
        .where("tenant_id", "=", alpha.tenantId)
        .where("session_id", "=", session.sessionId)
        .execute();
    });
    const recent = await http.inject({
      method: "GET",
      url: `/v1/conversations/${session.sessionId}`,
      headers: authorization(alpha.apiToken),
    });
    expect(recent.statusCode, recent.body).toBe(200);
    const page = recent.json<ConversationDetailResource>();
    expect(page.history.hasBefore).toBe(true);
    expect(page.turns.map((t) => t.turnId)).toEqual(ids.slice(5));
    const older = await http.inject({
      method: "GET",
      url: `/v1/conversations/${session.sessionId}?before=${encodeURIComponent(page.history.before!)}`,
      headers: authorization(alpha.apiToken),
    });
    expect(older.statusCode, older.body).toBe(200);
    expect(older.json<ConversationDetailResource>().turns.map((t) => t.turnId)).toEqual(
      ids.slice(0, 5),
    );
    expect(older.json<ConversationDetailResource>().history.hasBefore).toBe(false);
    const foreign = await http.inject({
      method: "GET",
      url: `/v1/conversations/${bravoSession.sessionId}?turnId=${ids[5]}`,
      headers: authorization(bravo.apiToken),
    });
    expect(foreign.statusCode).toBe(404);
  }, 60000);

  it("serializes concurrent registration at the configured total-tenant cap", async () => {
    const results = await Promise.all([
      register("capacity-charlie", "Charlie"),
      register("capacity-delta", "Delta"),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 429]);
    const rejected = results.find((response) => response.statusCode === 429)!;
    expect(rejected.json()).toEqual({
      error: {
        code: "registration_capacity_reached",
        message: "Self-service tenant registration capacity has been reached",
      },
    });
    expect(rejected.body).not.toContain("pck_");
    const count = await database
      .selectFrom("tenants")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect(count.count).toBe("4");
  });
});
