import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubAppClient } from "../src/github-app-client.ts";

function client(fetchImplementation: typeof fetch) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return new GitHubAppClient({
    appId: "12345",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    webhookSecret: "github-webhook-secret-with-at-least-32-bytes",
    fetch: fetchImplementation,
    clock: () => Date.UTC(2026, 7, 29, 0, 0, 0),
  });
}

describe("GitHub App client", () => {
  it("validates the exact raw Webhook body with HMAC-SHA256", () => {
    const github = client(vi.fn());
    const body = Buffer.from('{"action":"labeled","issue":{"title":"你好"}}', "utf8");
    const signature = `sha256=${createHmac("sha256", "github-webhook-secret-with-at-least-32-bytes")
      .update(body)
      .digest("hex")}`;
    expect(github.verifyWebhook(body, signature)).toBe(true);
    expect(github.verifyWebhook(Buffer.from(`${body.toString()} `), signature)).toBe(false);
  });

  it("mints a repository-scoped installation token without exposing it in the URL", async () => {
    const requests: Array<{ url: string; authorization: string; body: unknown }> = [];
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response(
        JSON.stringify({
          token: "ghs_repository_scoped_installation_token",
          expires_at: "2026-08-29T01:00:00Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const token = await client(fetchImplementation).installationToken("77", "123456", {
      contents: "read",
    });
    expect(token.token).toBe("ghs_repository_scoped_installation_token");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.github.com/app/installations/77/access_tokens");
    expect(requests[0]!.url).not.toContain(token.token);
    expect(requests[0]!.authorization.split(".")).toHaveLength(3);
    expect(requests[0]!.body).toEqual({
      repository_ids: [123456],
      permissions: { contents: "read" },
    });
  });

  it("discovers all repositories with an installation token", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "ghs_installation_discovery_token",
            expires_at: "2026-08-29T01:00:00Z",
          }),
          { status: 201 },
        );
      }
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
    });
    await expect(client(fetchImplementation).repositories("77")).resolves.toEqual([
      {
        id: "123456",
        owner: "example",
        name: "private-repo",
        fullName: "example/private-repo",
        private: true,
        defaultBranch: "main",
        cloneUrl: "https://github.com/example/private-repo.git",
      },
    ]);
  });
});
