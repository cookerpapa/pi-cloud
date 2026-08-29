import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { GitHubAppClient } from "../src/github-app-client.ts";
import { SourceControlService } from "../src/source-control-service.ts";
import { SourceControlIssueCoordinator } from "../src/source-control-issue-coordinator.ts";
import type { TenantRequestIdentity } from "../src/tenant-identity.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { SourceControlCredentialVault } from "../src/source-control-credential-vault.ts";

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
  it("connects a private GitLab project and accepts one signed Issue label delivery", async () => {
    const tenant = await createPrivateTenant(database, {
      slug: "gitlab-source-control-owner",
      ownerDisplayName: "GitLab Source Control Owner",
    });
    let signingToken = "";
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v4/projects/group%2Fprivate-repo")) {
        return new Response(
          JSON.stringify({
            id: 501,
            path: "private-repo",
            path_with_namespace: "group/private-repo",
            visibility: "private",
            default_branch: "main",
            http_url_to_repo: "https://gitlab.example.com/group/private-repo.git",
            web_url: "https://gitlab.example.com/group/private-repo",
            namespace: { id: 41, kind: "group" },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/v4/projects/501/hooks") && init?.method === undefined) {
        return new Response("[]", { status: 200 });
      }
      if (url.endsWith("/api/v4/projects/501/hooks") && init?.method === "POST") {
        signingToken = (JSON.parse(String(init.body)) as { signing_token: string }).signing_token;
        return new Response(JSON.stringify({ id: 91 }), { status: 201 });
      }
      if (
        url.endsWith("/api/v4/projects/501/members/all/42") ||
        url.endsWith("/api/v4/projects/501/members/all/43")
      ) {
        return new Response(JSON.stringify({ id: 42, access_level: 30 }), { status: 200 });
      }
      if (url.includes("/api/v4/projects/501/issues/12/notes") && init?.method === undefined) {
        return new Response("[]", { status: 200 });
      }
      if (url.endsWith("/api/v4/projects/501/issues/12/notes") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: 701 }), { status: 201 });
      }
      return new Response("{}", { status: 404 });
    });
    const service = new SourceControlService({
      database,
      gitlab: {
        vault: new SourceControlCredentialVault(Buffer.alloc(32, 9).toString("base64url")),
        webhookUrl: "https://picloud.example.com/v1/source-control/gitlab/webhook",
        publicOrigin: "https://picloud.example.com",
        issueLabel: "picloud",
        internalBaseUrl: "https://gitlab.internal.example.com",
        fetch: fetchImplementation,
      },
    });
    const configured = await service.connectGitLabProject(identity(tenant), {
      baseUrl: "https://gitlab.example.com",
      project: "group/private-repo",
      accessToken: "glpat-private-project-token",
    });
    expect(configured.installations[0]).toMatchObject({
      provider: "gitlab",
      providerBaseUrl: "https://gitlab.example.com",
      repositories: [{ fullName: "group/private-repo", private: true }],
    });
    const credentialRow = await database
      .selectFrom("source_control_credentials")
      .select(["ciphertext", "secret_sha256"])
      .where("tenant_id", "=", tenant.tenantId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(credentialRow)).not.toContain("glpat-private-project-token");
    await expect(
      database
        .selectFrom("source_control_repositories")
        .select(["provider_base_url", "clone_url"])
        .where("tenant_id", "=", tenant.tenantId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      provider_base_url: "https://gitlab.example.com",
      clone_url: "https://gitlab.internal.example.com/group/private-repo.git",
    });

    const payload = Buffer.from(
      JSON.stringify({
        object_kind: "issue",
        project: { id: 501 },
        user: { id: 7, username: "maintainer" },
        object_attributes: {
          action: "open",
          iid: 12,
          title: "Fix private sort",
          description: "The empty input fails.",
          url: "https://gitlab.example.com/group/private-repo/-/issues/12",
        },
        labels: [{ title: "picloud" }],
      }),
    );
    const deliveryId = "38d24a3b-9a33-4ab9-8ff4-a3c22499c001";
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = `v1,${createHmac("sha256", Buffer.from(signingToken.slice(6), "base64"))
      .update(Buffer.concat([Buffer.from(`${deliveryId}.${timestamp}.`), payload]))
      .digest("base64")}`;
    await expect(
      service.acceptGitLabWebhook({
        deliveryId,
        eventName: "Issue Hook",
        instance: "https://gitlab.example.com",
        timestamp,
        signature,
        rawBody: payload,
      }),
    ).resolves.toEqual({ accepted: true, replayed: false });
    await expect(
      database
        .selectFrom("source_control_issue_jobs")
        .select(["provider", "issue_number", "state"])
        .where("tenant_id", "=", tenant.tenantId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ provider: "gitlab", issue_number: 12, state: "awaiting_claim" });
    const pendingCoordinator = new SourceControlIssueCoordinator({
      database,
      sourceControl: service,
      instanceId: "gitlab-pending-coordinator",
      environmentImageRevision: "test",
      publicOrigin: "https://picloud.example.com/",
    });
    await expect(pendingCoordinator.claimNext()).resolves.toBeUndefined();
    await pendingCoordinator.close();
    const claimantUserId = randomUUID();
    const externalIdentityId = randomUUID();
    const secondClaimantUserId = randomUUID();
    const secondExternalIdentityId = randomUUID();
    await database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("users")
        .values({
          id: claimantUserId,
          tenant_id: tenant.tenantId,
          display_name: "GitLab Claimant",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("external_identities")
        .values({
          id: externalIdentityId,
          tenant_id: tenant.tenantId,
          user_id: claimantUserId,
          provider_key: "gitlab",
          issuer: "https://gitlab.example.com",
          subject: "gitlab-user-42",
          provider_user_id: "42",
          username: "gitlab-claimant",
          display_name: "GitLab Claimant",
          last_authenticated_at: new Date(),
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("users")
        .values({
          id: secondClaimantUserId,
          tenant_id: tenant.tenantId,
          display_name: "Second GitLab Claimant",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("external_identities")
        .values({
          id: secondExternalIdentityId,
          tenant_id: tenant.tenantId,
          user_id: secondClaimantUserId,
          provider_key: "gitlab",
          issuer: "https://gitlab.example.com",
          subject: "gitlab-user-43",
          provider_user_id: "43",
          username: "gitlab-second",
          display_name: "Second GitLab Claimant",
          last_authenticated_at: new Date(),
        })
        .executeTakeFirstOrThrow();
    });
    const claimant: TenantRequestIdentity = {
      credentialId: `oidc:${externalIdentityId}`,
      tenantId: tenant.tenantId,
      tenantSlug: tenant.tenantSlug,
      userId: claimantUserId,
      username: "gitlab-claimant",
      displayName: "GitLab Claimant",
      role: "member",
      defaultModelProfileId: tenant.defaultModelProfileId,
      authenticationKind: "oidc",
      externalIdentity: {
        id: externalIdentityId,
        providerKey: "gitlab",
        issuer: "https://gitlab.example.com",
        subject: "gitlab-user-42",
        providerUserId: "42",
        username: "gitlab-claimant",
      },
    };
    const pendingJob = (await service.listIssueJobs(claimant)).jobs[0]!;
    const secondClaimant: TenantRequestIdentity = {
      ...claimant,
      credentialId: `oidc:${secondExternalIdentityId}`,
      userId: secondClaimantUserId,
      username: "gitlab-second",
      displayName: "Second GitLab Claimant",
      externalIdentity: {
        ...claimant.externalIdentity!,
        id: secondExternalIdentityId,
        subject: "gitlab-user-43",
        providerUserId: "43",
        username: "gitlab-second",
      },
    };
    await expect(service.claimIssueJob(identity(tenant), pendingJob.jobId)).rejects.toMatchObject({
      code: "source_control_authorization_denied",
    });
    await expect(service.claimIssueJob(claimant, pendingJob.jobId)).resolves.toMatchObject({
      claimedByCurrentUser: true,
      claims: [{ username: "gitlab-claimant" }],
    });
    await expect(service.claimIssueJob(secondClaimant, pendingJob.jobId)).resolves.toMatchObject({
      claimedByCurrentUser: true,
      claims: [{ username: "gitlab-claimant" }, { username: "gitlab-second" }],
    });
    await expect(service.unclaimIssueJob(claimant, pendingJob.jobId)).resolves.toMatchObject({
      claimedByCurrentUser: false,
      claims: [{ username: "gitlab-second" }],
    });
    await service.claimIssueJob(claimant, pendingJob.jobId);
    await expect(
      service.startIssueJob(claimant, pendingJob.jobId, {
        executionMode: "development_environment",
        developmentEnvironmentId: randomUUID(),
        workingDirectory: "/etc/project",
      }),
    ).rejects.toMatchObject({ code: "source_control_conflict" });
    await expect(
      service.startIssueJob(claimant, pendingJob.jobId, {
        executionMode: "elastic",
        sandboxProfileKey: "starter",
      }),
    ).resolves.toMatchObject({ state: "received" });
    await expect(service.unclaimIssueJob(claimant, pendingJob.jobId)).rejects.toMatchObject({
      code: "source_control_conflict",
    });
    await database
      .updateTable("source_control_issue_jobs")
      .set({ state: "cancelled", settled_at: new Date(), updated_at: new Date() })
      .where("tenant_id", "=", tenant.tenantId)
      .executeTakeFirstOrThrow();
  });

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
          kind: "source_control",
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
            kind: "source_control",
            status: "ready",
            repositoryId: request.source.repositoryId,
            provider: "github",
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
    const findChangeRequest = vi.spyOn(service, "findChangeRequest").mockResolvedValue(undefined);
    const createChangeRequest = vi.spyOn(service, "createChangeRequest").mockResolvedValue({
      number: 9,
      url: "https://github.com/example/private-repo/pull/9",
    });
    const findIssueComment = vi
      .spyOn(service, "findIssueDeliveryComment")
      .mockResolvedValue(undefined);
    const createIssueComment = vi
      .spyOn(service, "createIssueDeliveryComment")
      .mockResolvedValue({ id: "9001" });

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
      .where("provider", "=", "github")
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
        .select(["state", "commit_sha", "change_request_url", "issue_comment_id"])
        .where("id", "=", queued.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      state: "completed",
      commit_sha: "b".repeat(40),
      change_request_url: "https://github.com/example/private-repo/pull/9",
      issue_comment_id: "9001",
    });
    expect(findChangeRequest).toHaveBeenCalledOnce();
    expect(createChangeRequest).toHaveBeenCalledOnce();
    expect(findIssueComment).toHaveBeenCalledOnce();
    expect(createIssueComment).toHaveBeenCalledOnce();
    await coordinator.close();
  });
});
