import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createHmac, generateKeyPairSync } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { GitHubAppClient } from "../src/github-app-client.ts";
import { SourceControlService } from "../src/source-control-service.ts";
import { SourceControlIssueCoordinator } from "../src/source-control-issue-coordinator.ts";
import type { TenantRequestIdentity } from "../src/tenant-identity.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";

let pglite: PGlite;
let socket: PGLiteSocketServer;
let database: Kysely<Database>;

beforeAll(async () => {
  pglite = await PGlite.create();
  socket = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 4,
  });
  await socket.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  await runMigrations(database, "up");
});

afterAll(async () => {
  await database.destroy();
  await socket.stop();
  await pglite.close();
});

function identity(tenant: Awaited<ReturnType<typeof createPrivateTenant>>): TenantRequestIdentity {
  return {
    credentialId: tenant.credential.credentialId,
    tenantId: tenant.tenantId,
    tenantSlug: tenant.tenantSlug,
    userId: tenant.ownerUserId,
    displayName: "Owner",
    role: "owner",
    defaultModelProfileId: tenant.defaultModelProfileId,
  };
}

describe.sequential("source-control App boundary", () => {
  it("binds one GitHub installation to one tenant and turns an explicit label into one durable job", async () => {
    const tenant = await createPrivateTenant(database, {
      slug: "source-control-owner",
      ownerDisplayName: "Source Control Owner",
    });
    const other = await createPrivateTenant(database, {
      slug: "source-control-other",
      ownerDisplayName: "Other Owner",
    });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app/installations/77")) {
        return new Response(
          JSON.stringify({
            id: 77,
            account: { id: 88, login: "example", type: "Organization" },
            repository_selection: "selected",
            permissions: {
              metadata: "read",
              contents: "write",
              issues: "write",
              pull_requests: "write",
            },
            suspended_at: null,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/app/installations/77/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "ghs_discovery_token_not_persisted",
            expires_at: "2026-08-29T01:00:00Z",
          }),
          { status: 201 },
        );
      }
      if (url.includes("/installation/repositories")) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            repositories: [
              {
                id: 123456,
                name: "private-repo",
                full_name: "example/private-repo",
                private: true,
                default_branch: "main",
                clone_url: "https://github.com/example/private-repo.git",
                owner: { login: "example" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });
    const webhookSecret = "github-source-control-test-webhook-secret";
    const service = new SourceControlService({
      database,
      github: {
        appSlug: "picloud-test",
        issueLabel: "picloud",
        client: new GitHubAppClient({
          appId: "12345",
          privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          webhookSecret,
          fetch: fetchImplementation,
        }),
      },
    });
    const link = await service.beginGitHubInstall(identity(tenant));
    const state = new URL(link.url).searchParams.get("state")!;
    await service.completeGitHubInstall(identity(tenant), state, "77");
    await expect(
      service.completeGitHubInstall(identity(tenant), state, "77"),
    ).rejects.toMatchObject({ code: "source_control_authorization_denied" });
    const configured = await service.configuration(identity(tenant));
    expect(configured.installations).toHaveLength(1);
    expect(configured.installations[0]?.repositories[0]).toMatchObject({
      fullName: "example/private-repo",
      private: true,
      state: "active",
    });
    await expect(service.configuration(identity(other))).resolves.toMatchObject({
      installations: [],
    });
    await expect(
      new ControlPlaneStore({
        database,
        tenantId: other.tenantId,
        defaultModelProfileId: other.defaultModelProfileId,
      }).createProject({
        name: "foreign-private-repo",
        source: {
          kind: "github",
          repositoryId: configured.installations[0]!.repositories[0]!.repositoryId,
        },
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    const payload = Buffer.from(
      JSON.stringify({
        action: "labeled",
        installation: { id: 77 },
        repository: { id: 123456 },
        label: { name: "picloud" },
        issue: {
          number: 42,
          title: "Fix the insertion sort edge case",
          body: "The empty input fails.",
          html_url: "https://github.com/example/private-repo/issues/42",
        },
        sender: { login: "maintainer" },
      }),
    );
    const signature = `sha256=${createHmac("sha256", webhookSecret).update(payload).digest("hex")}`;
    await expect(
      service.acceptGitHubWebhook({
        deliveryId: "forged-delivery",
        eventName: "issues",
        signature: `sha256=${"0".repeat(64)}`,
        rawBody: payload,
      }),
    ).rejects.toMatchObject({ code: "source_control_webhook_invalid" });
    await expect(
      service.acceptGitHubWebhook({
        deliveryId: "delivery-1",
        eventName: "issues",
        signature,
        rawBody: payload,
      }),
    ).resolves.toEqual({ accepted: true, replayed: false });
    await expect(
      service.acceptGitHubWebhook({
        deliveryId: "delivery-1",
        eventName: "issues",
        signature,
        rawBody: payload,
      }),
    ).resolves.toEqual({ accepted: true, replayed: true });

    const jobs = await service.listIssueJobs(identity(tenant));
    expect(jobs.jobs).toHaveLength(1);
    expect(jobs.jobs[0]).toMatchObject({
      issueNumber: 42,
      repositoryFullName: "example/private-repo",
      state: "received",
    });
    const columns = await database
      .selectFrom("source_control_installations")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(columns)).not.toContain("ghs_discovery_token_not_persisted");

    const coordinatorA = new SourceControlIssueCoordinator({
      database,
      sourceControl: service,
      instanceId: "issue-coordinator-a",
      environmentImageRevision: "test",
      publicOrigin: "https://picloud.example.com/",
    });
    const coordinatorB = new SourceControlIssueCoordinator({
      database,
      sourceControl: service,
      instanceId: "issue-coordinator-b",
      environmentImageRevision: "test",
      publicOrigin: "https://picloud.example.com/",
    });
    const claimed = await Promise.all([coordinatorA.claimNext(), coordinatorB.claimNext()]);
    expect(claimed.filter((value) => value !== undefined)).toHaveLength(1);
    await Promise.all([coordinatorA.close(), coordinatorB.close()]);

    await database
      .updateTable("source_control_issue_jobs")
      .set({ owner_id: null, lease_expires_at: null, available_at: new Date() })
      .execute();
    await database
      .insertInto("user_password_credentials")
      .values({
        username: "source.control.owner",
        tenant_id: tenant.tenantId,
        user_id: tenant.ownerUserId,
        role: "owner",
        password_salt: "a".repeat(22),
        password_hash: "b".repeat(43),
        scrypt_n: 16_384,
        scrypt_r: 8,
        scrypt_p: 1,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("sandbox_domains")
      .values({
        id: "sandbox-domain-source-control",
        display_name: "Source Control Test",
        state: "active",
        tool_broker_base_url: "http://tool-broker.invalid:4300",
        workspace_storage_key: "source-control-test",
        maximum_active_sandboxes: 8,
      })
      .executeTakeFirstOrThrow();

    vi.spyOn(service, "createRepositoryProject").mockImplementation(
      async (_identity, store, request) => {
        const project = await store.createProject(request);
        await database
          .updateTable("workspace_source_repositories")
          .set({ checkout_state: "ready", base_sha: "a".repeat(40), failure_code: null })
          .where("workspace_id", "=", project.workspaceId)
          .executeTakeFirstOrThrow();
        return {
          ...project,
          source: {
            kind: "github",
            status: "ready",
            repositoryId: request.source.repositoryId,
            fullName: "example/private-repo",
            baseRef: "main",
            baseSha: "a".repeat(40),
          },
        };
      },
    );
    vi.spyOn(service, "publishIssueWorkspace").mockResolvedValue({
      changed: true,
      commitSha: "b".repeat(40),
    });
    const githubDelivery = {
      findPullRequest: vi.fn().mockResolvedValue(undefined),
      createPullRequest: vi.fn().mockResolvedValue({
        number: 9,
        url: "https://github.com/example/private-repo/pull/9",
      }),
      findIssueComment: vi.fn().mockResolvedValue(undefined),
      createIssueComment: vi.fn().mockResolvedValue({ id: "9001" }),
    };
    vi.spyOn(service, "githubClient").mockReturnValue(githubDelivery as never);

    const coordinator = new SourceControlIssueCoordinator({
      database,
      sourceControl: service,
      instanceId: "issue-coordinator-flow",
      environmentImageRevision: "test",
      publicOrigin: "https://picloud.example.com/",
    });
    await expect(coordinator.reconcileOnce()).resolves.toBe(true);
    const queued = await database
      .selectFrom("source_control_issue_jobs")
      .select(["id", "state", "run_id", "session_id"])
      .executeTakeFirstOrThrow();
    expect(queued).toMatchObject({ state: "queued" });
    expect(queued.run_id).toMatch(/^[0-9a-f-]{36}$/);
    await database.transaction().execute(async (transaction) => {
      const run = await transaction
        .selectFrom("runs")
        .select(["turn_id", "session_id"])
        .where("id", "=", queued.run_id!)
        .executeTakeFirstOrThrow();
      const settled = new Date();
      await transaction
        .updateTable("runs")
        .set({ state: "completed", settled_at: settled, updated_at: settled })
        .where("id", "=", queued.run_id!)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("turns")
        .set({ state: "completed", settled_at: settled })
        .where("id", "=", run.turn_id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("sessions")
        .set({ state: "idle", updated_at: settled })
        .where("id", "=", run.session_id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("source_control_issue_jobs")
        .set({ available_at: settled })
        .where("id", "=", queued.id)
        .executeTakeFirstOrThrow();
    });
    await expect(coordinator.reconcileOnce()).resolves.toBe(true);
    await database
      .updateTable("source_control_issue_jobs")
      .set({ available_at: new Date() })
      .where("id", "=", queued.id)
      .executeTakeFirstOrThrow();
    await expect(coordinator.reconcileOnce()).resolves.toBe(true);
    await expect(
      database
        .selectFrom("source_control_issue_jobs")
        .select(["state", "commit_sha", "pull_request_url", "issue_comment_id"])
        .where("id", "=", queued.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      state: "completed",
      commit_sha: "b".repeat(40),
      pull_request_url: "https://github.com/example/private-repo/pull/9",
      issue_comment_id: "9001",
    });
    expect(githubDelivery.createPullRequest).toHaveBeenCalledOnce();
    expect(githubDelivery.createIssueComment).toHaveBeenCalledOnce();
    await coordinator.close();
  });
});
