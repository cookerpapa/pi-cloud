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

  it("mints a metadata-only discovery token without exposing it in the URL", async () => {
    const requests: Array<{ url: string; authorization: string; body: unknown }> = [];
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (init?.method !== "POST") return Response.json({ repositories: [] });
      return new Response(
        JSON.stringify({
          token: "ghs_repository_scoped_installation_token",
          expires_at: "2026-08-29T01:00:00Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    await client(fetchImplementation).repositories("77");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe("https://api.github.com/app/installations/77/access_tokens");
    expect(
      requests.every(
        (request) => !request.url.includes("ghs_repository_scoped_installation_token"),
      ),
    ).toBe(true);
    expect(requests[0]!.authorization.split(".")).toHaveLength(3);
    expect(requests[0]!.body).toEqual({
      permissions: { metadata: "read" },
    });
  });

  it("accepts read-only Issue intake without retired delivery permissions", async () => {
    await expect(
      client(async () =>
        Response.json({
          id: 77,
          account: { id: 88, login: "example", type: "Organization" },
          repository_selection: "selected",
          permissions: { metadata: "read", issues: "read" },
          suspended_at: null,
        }),
      ).installation("77"),
    ).resolves.toMatchObject({ id: "77" });
  });

  it("stops reading an oversized response instead of buffering its entire body", async () => {
    let pulls = 0;
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ < 32) controller.enqueue(new Uint8Array(256 * 1024));
          else controller.close();
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    await expect(client(async () => response).installation("77")).rejects.toMatchObject({
      code: "github_response_invalid",
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(32);
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
