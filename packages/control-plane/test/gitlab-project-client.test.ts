import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitLabProjectClient } from "../src/gitlab-project-client.ts";
import { SourceControlCredentialVault } from "../src/source-control-credential-vault.ts";

describe("GitLab project adapter", () => {
  it("discovers one private project and reconciles its signed Webhook", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith("/api/v4/projects/group%2Fprivate-project")) {
        return new Response(
          JSON.stringify({
            id: 77,
            path: "private-project",
            path_with_namespace: "group/private-project",
            visibility: "private",
            default_branch: "main",
            http_url_to_repo: "https://gitlab.example.com/group/private-project.git",
            web_url: "https://gitlab.example.com/group/private-project",
            namespace: { id: 88, kind: "group" },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/v4/projects/77/hooks") && init?.method === undefined) {
        return new Response("[]", { status: 200 });
      }
      if (url.endsWith("/api/v4/projects/77/hooks") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: 99 }), { status: 201 });
      }
      return new Response("{}", { status: 404 });
    });
    const client = new GitLabProjectClient({
      baseUrl: "https://gitlab.example.com",
      accessToken: "glpat-project-scoped-secret",
      fetch: fetchImplementation,
    });
    await expect(client.project("group/private-project")).resolves.toMatchObject({
      id: "77",
      fullName: "group/private-project",
      private: true,
    });
    await expect(
      client.ensureWebhook({
        projectId: "77",
        url: "https://picloud.example.com/v1/source-control/gitlab/webhook",
        signingToken: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
      }),
    ).resolves.toBe("99");
    expect(requests.every((request) => request.init?.headers !== undefined)).toBe(true);
    expect(requests.every((request) => !request.url.includes("glpat-project-scoped-secret"))).toBe(
      true,
    );
    expect(
      requests.every(
        (request) => !String(request.init?.body ?? "").includes("glpat-project-scoped-secret"),
      ),
    ).toBe(true);
  });

  it("authenticates Standard Webhook signatures and encrypted project credentials", () => {
    const masterKey = Buffer.alloc(32, 3).toString("base64url");
    const signingToken = `whsec_${Buffer.alloc(32, 4).toString("base64")}`;
    const vault = new SourceControlCredentialVault(masterKey, {
      randomBytes: () => Buffer.alloc(12, 5),
    });
    const identity = {
      tenantId: "tenant-1",
      installationId: "installation-1",
      provider: "gitlab" as const,
      version: 1,
    };
    const credential = {
      accessToken: "glpat-project-scoped-secret",
      webhookSigningToken: signingToken,
    };
    const sealed = vault.seal(identity, credential);
    expect(JSON.stringify(sealed)).not.toContain(credential.accessToken);
    expect(vault.open(identity, sealed)).toEqual(credential);

    const rawBody = Buffer.from('{"object_kind":"issue"}');
    const messageId = "5b727c44-940d-4fe9-b33a-e1bbcc012345";
    const timestamp = "1787961600";
    const signed = Buffer.concat([Buffer.from(`${messageId}.${timestamp}.`), rawBody]);
    const signature = `v1,${createHmac("sha256", Buffer.alloc(32, 4)).update(signed).digest("base64")}`;
    expect(
      GitLabProjectClient.verifyWebhook({
        signingToken,
        messageId,
        timestamp,
        signature,
        rawBody,
        now: 1_787_961_600_000,
      }),
    ).toBe(true);
    expect(
      GitLabProjectClient.verifyWebhook({
        signingToken,
        messageId,
        timestamp,
        signature,
        rawBody: Buffer.concat([rawBody, Buffer.from(" ")]),
        now: 1_787_961_600_000,
      }),
    ).toBe(false);
  });
});
