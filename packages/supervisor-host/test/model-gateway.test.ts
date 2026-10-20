import {
  createExecutionReference,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  modelSamplingHeaders,
  type ExecuteTurnCommandMessage,
} from "@pi-cloud/protocol";
import { zstdCompressSync } from "node:zlib";
import { request as httpRequest, type ClientRequest } from "node:http";
import { PiCloudMetrics } from "@pi-cloud/observability";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantModelGateway } from "../src/index.ts";

const PROVIDER_GATEWAY_KEY = `cpa_${"k".repeat(48)}`;
let sequence = 0;

function samplingHeaders(): Record<string, string> {
  sequence += 1;
  return modelSamplingHeaders({
    stepSequence: sequence,
    stepSha256: sequence.toString(16).padStart(64, "0"),
    samplingAttempt: 1,
  });
}

function command(
  provider: "deepseek" | "openai-codex" = "deepseek",
  modelId:
    | "deepseek-v4-flash"
    | "deepseek-v4-pro"
    | "gpt-6-luna"
    | "gpt-6-astra"
    | "gpt-6-sol" = "deepseek-v4-flash",
  serviceTier: "fast" | null = null,
): ExecuteTurnCommandMessage {
  return {
    protocolVersion: 1,
    messageId: "10000000-0000-4000-8000-000000000001",
    sentAt: "2026-08-31T00:00:00.000Z",
    type: "command.turn.execute",
    payload: {
      idempotencyKey: "model-gateway-test",
      tenantId: "10000000-0000-4000-8000-000000000002",
      projectId: "10000000-0000-4000-8000-000000000003",
      workspaceId: "10000000-0000-4000-8000-000000000004",
      sessionId: "10000000-0000-4000-8000-000000000005",
      piSession: {
        id: "10000000-0000-4000-8000-000000000005",
        conversationId: 1,
        writerId: "10000000-0000-4000-8000-000000000009",
      },
      runId: "10000000-0000-4000-8000-000000000006",
      turnId: "10000000-0000-4000-8000-000000000007",
      agentId: "root",
      executionReference: createExecutionReference(
        "10000000-0000-4000-8000-000000000008",
        "10000000-0000-4000-8000-000000000009",
        1,
      ),
      nextEventSeq: 1,
      agent: {
        revisionId: "10000000-0000-4000-8000-000000000010",
        definitionKey: "pi-coding",
        runtimeKind: "pi_sdk",
        runtimeVersion: "1.0.0",
        harnessVersion: "pi-cloud-harness-v1",
        sessionStorageKind: "pi_durable_storage_v1",
      },
      input: { kind: "prompt", text: "hello" },
      executionMode: "elastic",
      sessionKind: "conversation",
      workspaceSeedKind: "empty",
      sandboxProfileKey: "standard",
      workingDirectory: "/workspace",
      toolCapabilities: ["read", "write", "edit", "bash"],
      model: {
        profileId: "10000000-0000-4000-8000-000000000011",
        provider,
        modelId,
        thinkingLevel: provider === "openai-codex" ? "medium" : "off",
        serviceTier,
        credentialBindingId: "10000000-0000-4000-8000-000000000012",
        credentialBindingVersion: 2,
      },
      environment: {
        environmentVersionId: "10000000-0000-4000-8000-000000000013",
        versionNumber: 1,
        profileKey: "pi-cloud-fullstack",
        profileVersion: "1",
        imageRevision: "test",
        specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
        recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
        recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
      },
    },
  };
}

const gateways: TenantModelGateway[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

it("keeps an owned model grant beyond the former TTL and rejects it immediately after revocation", async () => {
  const upstream = vi.fn<typeof fetch>(async () => new Response("ok"));
  const gateway = createGateway(upstream);
  await gateway.start();
  const owner = new AbortController();
  const lease = gateway.issue(command(), owner.signal);
  const token = JSON.parse(
    Buffer.from(lease.runtime.capability.split(".")[1]!, "base64url").toString(),
  );
  expect(token).not.toHaveProperty("exp");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60_000);
  const send = () =>
    fetch(`http://127.0.0.1:${gateway.listeningPort}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.runtime.capability}`, ...samplingHeaders() },
      body: JSON.stringify({ model: "deepseek-v4-flash", stream: true, input: [] }),
    });
  const active = await send();
  expect(active.status).toBe(200);
  await active.text();
  owner.abort();
  const stale = await send();
  expect(stale.status).toBe(401);
  await stale.text();
  expect(upstream).toHaveBeenCalledOnce();
  await expect(() => gateway.issue(command(), owner.signal)).toThrow();
});

function createGateway(
  fetchImplementation: typeof fetch,
  maximumRequestsPerTurn = 8,
  timeouts: {
    upstreamConnectTimeoutMs?: number;
    upstreamIdleTimeoutMs?: number;
    metrics?: PiCloudMetrics;
  } = {},
) {
  const gateway = new TenantModelGateway({
    host: "127.0.0.1",
    port: 0,
    advertisedBaseUrl: "http://pi-worker:4200",
    providerGatewayBaseUrl: "http://provider-gateway:8317",
    providerGatewayApiKey: PROVIDER_GATEWAY_KEY,
    maximumRequestsPerTurn,
    ...timeouts,
    fetchImplementation,
  });
  gateways.push(gateway);
  return gateway;
}

describe("tenant model gateway", () => {
  it("shares the root request budget across Conversation capabilities and independent release", async () => {
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response('data: {"type":"response.completed","response":{"id":"root"}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const gateway = createGateway(upstream, 1);
    await gateway.start();
    const rootCommand = command("openai-codex", "gpt-6-luna");
    const root = gateway.issue(rootCommand),
      child = gateway.issue({
        ...rootCommand,
        payload: {
          ...rootCommand.payload,
          sessionId: crypto.randomUUID(),
          sessionKind: "subagent",
          piSession: { ...rootCommand.payload.piSession, conversationId: 2 },
        },
      });
    const request = async (capability: string) => {
      const response = await fetch(`http://127.0.0.1:${gateway.listeningPort}/codex/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${capability}`,
          "content-type": "application/json",
          ...samplingHeaders(),
        },
        body: JSON.stringify({ model: "gpt-6-luna", stream: true, input: [] }),
      });
      await response.text();
      return response.status;
    };
    expect(await request(root.runtime.capability)).toBe(200);
    await root.release();
    expect(await request(child.runtime.capability)).toBe(429);
    expect(upstream).toHaveBeenCalledOnce();
    await child.release();
  });
  function partialRequest(gateway: TenantModelGateway, capability: string) {
    let request!: ClientRequest;
    const started = Promise.withResolvers<void>();
    const response = new Promise<{ status?: number; error?: NodeJS.ErrnoException }>((resolve) => {
      request = httpRequest(
        `http://127.0.0.1:${gateway.listeningPort}/v1/responses`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${capability}`,
            "content-type": "application/json",
            expect: "100-continue",
            ...samplingHeaders(),
          },
        },
        (res) => {
          res.resume();
          res.once("end", () => resolve({ status: res.statusCode! }));
        },
      );
      request.once("error", (error) => resolve({ error }));
      request.once("continue", () => started.resolve());
      request.setTimeout(3000, () => request.destroy(new Error("Test upload did not settle")));
      request.write('{"model":"deepseek-v4-pro",');
    });
    return { request, response, started: started.promise };
  }

  it.each(["release", "shutdown", "owner_loss"])(
    "rejects an in-flight upload after %s",
    async (action) => {
      const upstream = vi.fn<typeof fetch>();
      const owner = new AbortController();
      const gateway = createGateway(upstream, 1);
      await gateway.start();
      const lease = gateway.issue(command("deepseek", "deepseek-v4-pro"), owner.signal);
      const upload = partialRequest(gateway, lease.runtime.capability);
      try {
        await upload.started;
        if (action === "owner_loss") owner.abort();
        else if (action === "release") await lease.release();
        else await gateway.close();
        const result = await upload.response;
        expect(result.error?.code).toBe("ECONNRESET");
        expect(upstream).not.toHaveBeenCalled();
      } finally {
        upload.request.destroy();
        await lease.release();
      }
    },
  );

  it("reserves the last model request once when concurrent uploads finish", async () => {
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response('data: {"type":"response.completed","response":{"id":"r1"}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const gateway = createGateway(upstream, 1);
    await gateway.start();
    const lease = gateway.issue(command("deepseek", "deepseek-v4-pro"));
    const uploads = [
      partialRequest(gateway, lease.runtime.capability),
      partialRequest(gateway, lease.runtime.capability),
    ];
    try {
      await Promise.all(uploads.map((upload) => upload.started));
      for (const upload of uploads) upload.request.end('"stream":true,"input":[]}');
      expect(
        (await Promise.all(uploads.map((u) => u.response))).map((r) => r.status).sort(),
      ).toEqual([200, 429]);
      expect(upstream).toHaveBeenCalledOnce();
    } finally {
      for (const upload of uploads) upload.request.destroy();
      await lease.release();
    }
  });

  it("does not spend a request reservation on malformed input", async () => {
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response('data: {"type":"response.completed","response":{"id":"r1"}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const gateway = createGateway(upstream, 1);
    await gateway.start();
    const lease = gateway.issue(command("deepseek", "deepseek-v4-pro"));
    try {
      for (const [body, status] of [
        ["{bad", 400],
        [JSON.stringify({ model: "deepseek-v4-pro", stream: true, input: [] }), 200],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${gateway.listeningPort}/v1/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${lease.runtime.capability}`,
            "content-type": "application/json",
            ...samplingHeaders(),
          },
          body,
        });
        expect(response.status).toBe(status);
        await response.text();
      }
      expect(upstream).toHaveBeenCalledOnce();
    } finally {
      await lease.release();
    }
  });

  it("enforces a Turn capability and forwards native DeepSeek Responses with stable Session affinity", async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://provider-gateway:8317/v1/responses");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${PROVIDER_GATEWAY_KEY}`);
      expect(headers.get("session-id")).toBe(command().payload.sessionId);
      expect(JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8")).tools).toEqual([
        { type: "web_search" },
      ]);
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n',
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    const gateway = createGateway(upstream);
    await gateway.start();
    const lease = gateway.issue(command());
    expect(lease.runtime).toMatchObject({
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      api: "openai-responses",
      baseUrl: "http://pi-worker:4200/v1",
      inputModalities: ["text", "image"],
      hostedTools: ["web_search"],
    });
    const capabilityPayload = JSON.parse(
      Buffer.from(lease.runtime.capability.split(".")[1]!, "base64url").toString("utf8"),
    ) as Record<string, { chatgpt_account_id?: string }>;
    expect(capabilityPayload["https://api.openai.com/auth"]?.chatgpt_account_id).toBe(
      "pi-cloud-provider-gateway",
    );
    const response = await fetch(`http://127.0.0.1:${String(gateway.listeningPort)}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.runtime.capability}`,
        "content-type": "application/json",
        ...samplingHeaders(),
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        stream: true,
        input: [],
        tools: [{ type: "web_search" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"delta":"ok"');
    await lease.release();
    expect(
      (
        await fetch(`http://127.0.0.1:${String(gateway.listeningPort)}/v1/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${lease.runtime.capability}`, ...samplingHeaders() },
          body: JSON.stringify({ model: "deepseek-v4-flash", stream: true }),
        })
      ).status,
    ).toBe(401);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("preserves Pi's native Codex Responses protocol and zstd body", async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://provider-gateway:8317/v1/responses");
      expect(new Headers(init?.headers).get("content-encoding")).toBe("zstd");
      expect(init?.body).toBeInstanceOf(Uint8Array);
      return new Response('data: {"type":"response.completed","response":{"id":"r1"}}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const gateway = createGateway(upstream);
    await gateway.start();
    const lease = gateway.issue(command("openai-codex", "gpt-6-sol"));
    expect(lease.runtime).toMatchObject({
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "http://pi-worker:4200",
      inputModalities: ["text", "image"],
      hostedTools: ["web_search"],
    });
    const body = zstdCompressSync(
      Buffer.from(JSON.stringify({ model: "gpt-6-sol", stream: true, input: [] })),
    );
    const response = await fetch(
      `http://127.0.0.1:${String(gateway.listeningPort)}/codex/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${lease.runtime.capability}`,
          "content-encoding": "zstd",
          "content-type": "application/json",
          ...samplingHeaders(),
        },
        body,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("response.completed");
  });

  it("forwards an image request larger than the former 8 MiB limit without rewriting it", async () => {
    const body = JSON.stringify({
      model: "gpt-6-luna",
      stream: true,
      input: [
        {
          type: "function_call_output",
          call_id: "image-call",
          output: [
            {
              type: "input_image",
              image_url: "data:image/png;base64," + "A".repeat(9 * 1024 * 1024),
            },
          ],
        },
      ],
    });
    const upstream = vi.fn<typeof fetch>(async (_input, init) => {
      expect(Buffer.from(init!.body as Uint8Array).toString()).toBe(body);
      return new Response('data: {"type":"response.completed","response":{"id":"image"}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const gateway = createGateway(upstream);
    await gateway.start();
    const lease = gateway.issue(command("openai-codex", "gpt-6-luna"));
    const result = await fetch(`http://127.0.0.1:${gateway.listeningPort}/codex/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.runtime.capability}`,
        "content-type": "application/json",
        ...samplingHeaders(),
      },
      body,
    });
    expect(result.status).toBe(200);
    await result.text();
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("binds Fast mode to the issued GPT Turn and rejects a mismatched request", async () => {
    const upstream = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))).toMatchObject({
        service_tier: "fast",
      });
      return new Response('data: {"type":"response.completed","response":{"id":"r1"}}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const gateway = createGateway(upstream);
    await gateway.start();
    const lease = gateway.issue(command("openai-codex", "gpt-6-sol", "fast"));
    expect(lease.runtime.serviceTier).toBe("fast");
    expect(lease.runtime.contextWindow).toBe(1_000_000);
    expect(lease.runtime.autoCompactTokenLimit).toBe(900_000);
    const endpoint = `http://127.0.0.1:${String(gateway.listeningPort)}/codex/responses`;
    const accepted = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.runtime.capability}`,
        "content-type": "application/json",
        ...samplingHeaders(),
      },
      body: JSON.stringify({
        model: "gpt-6-sol",
        stream: true,
        service_tier: "fast",
        input: [],
      }),
    });
    expect(accepted.status).toBe(200);
    await accepted.text();
    const rejected = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.runtime.capability}`,
        "content-type": "application/json",
        ...samplingHeaders(),
      },
      body: JSON.stringify({ model: "gpt-6-sol", stream: true, input: [] }),
    });
    expect(rejected.status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("leaves failed sampling retries to the Runner instead of hiding extra upstream sends", async () => {
    let attempts = 0;
    const upstream = vi.fn<typeof fetch>(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('{"error":{"code":"transport_failure"}}', { status: 500 });
      }
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"recovered"}\n\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const gateway = createGateway(upstream);
    await gateway.start();
    const lease = gateway.issue(command());
    const response = await fetch(`http://127.0.0.1:${String(gateway.listeningPort)}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.runtime.capability}`,
        "content-type": "application/json",
        ...samplingHeaders(),
      },
      body: JSON.stringify({ model: "deepseek-v4-flash", stream: true, input: [] }),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("transport_failure");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("applies the upstream timeout to connection and stream idleness instead of total duration", async () => {
    const encoder = new TextEncoder();
    const upstream = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const timers = [
              setTimeout(
                () =>
                  controller.enqueue(
                    encoder.encode(
                      'data: {"type":"response.output_text.delta","delta":"still "}\n\n',
                    ),
                  ),
                5,
              ),
              setTimeout(
                () =>
                  controller.enqueue(
                    encoder.encode(
                      'data: {"type":"response.output_text.delta","delta":"active"}\n\n',
                    ),
                  ),
                25,
              ),
              setTimeout(() => {
                controller.enqueue(
                  encoder.encode('data: {"type":"response.completed","response":{"id":"r1"}}\n\n'),
                );
                controller.close();
              }, 50),
            ];
            signal?.addEventListener(
              "abort",
              () => {
                for (const timer of timers) clearTimeout(timer);
                controller.error(new Error("upstream aborted"));
              },
              { once: true },
            );
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const gateway = createGateway(upstream, 8, {
      upstreamConnectTimeoutMs: 20,
      upstreamIdleTimeoutMs: 40,
    });
    await gateway.start();
    const lease = gateway.issue(command());
    const response = await fetch(`http://127.0.0.1:${String(gateway.listeningPort)}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.runtime.capability}`,
        "content-type": "application/json",
        ...samplingHeaders(),
      },
      body: JSON.stringify({ model: "deepseek-v4-flash", stream: true, input: [] }),
    });
    const body = await response.text();
    expect(body).toContain('"delta":"still "');
    expect(body).toContain('"delta":"active"');
    expect(body).toContain("response.completed");
    expect(body).not.toContain("provider_gateway_idle_timeout");
  });

  it("returns a protocol-visible failure when an established Provider stream becomes idle", async () => {
    const encoder = new TextEncoder();
    const upstream = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"type":"response.created","response":{"id":"r1"}}\n\n'),
            );
            signal?.addEventListener(
              "abort",
              () => controller.error(new Error("upstream aborted")),
              { once: true },
            );
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const gateway = createGateway(upstream, 8, {
      upstreamConnectTimeoutMs: 100,
      upstreamIdleTimeoutMs: 20,
    });
    await gateway.start();
    const lease = gateway.issue(command());
    const response = await fetch(`http://127.0.0.1:${String(gateway.listeningPort)}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.runtime.capability}`,
        "content-type": "application/json",
        ...samplingHeaders(),
      },
      body: JSON.stringify({ model: "deepseek-v4-flash", stream: true, input: [] }),
    });
    expect(await response.text()).toContain("provider_gateway_idle_timeout");
  });

  it("releases a backpressured Provider response when the Pi client disconnects", async () => {
    const metrics = new PiCloudMetrics("gateway-disconnect-test");
    const observe = vi.spyOn(metrics.modelTransportDuration, "observe");
    const cancelled = vi.fn();
    const chunk = new TextEncoder().encode(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(8 * 1024 * 1024) })}\n\n`,
    );
    const gateway = createGateway(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(chunk);
            },
            cancel: cancelled,
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      8,
      { metrics },
    );
    await gateway.start();
    const lease = gateway.issue(command());
    const client = httpRequest(`http://127.0.0.1:${gateway.listeningPort}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.runtime.capability}`, ...samplingHeaders() },
    });
    try {
      const connected = new Promise<void>((resolve, reject) => {
        client.once("response", (response) => {
          response.pause();
          resolve();
        });
        client.once("error", reject);
      });
      client.end(JSON.stringify({ model: "deepseek-v4-flash", stream: true, input: [] }));
      await connected;
      expect(observe).not.toHaveBeenCalled();
      client.destroy();
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(observe).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "disconnected" }),
          expect.any(Number),
        ),
      );
    } finally {
      client.destroy();
      await lease.release();
    }
  });

  it("rejects protocol, model, Step identity and request-count violations before forwarding", async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response("unexpected"));
    const gateway = createGateway(upstream, 1);
    await gateway.start();
    const lease = gateway.issue(command());
    const endpoint = `http://127.0.0.1:${String(gateway.listeningPort)}`;
    const noStep = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.runtime.capability}` },
      body: JSON.stringify({ model: "deepseek-v4-flash", stream: true }),
    });
    expect(noStep.status).toBe(400);
    const wrongProtocol = await fetch(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.runtime.capability}`, ...samplingHeaders() },
      body: JSON.stringify({ model: "deepseek-v4-flash", stream: true }),
    });
    expect(wrongProtocol.status).toBe(403);
    const wrongModel = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.runtime.capability}`, ...samplingHeaders() },
      body: JSON.stringify({ model: "deepseek-v4-pro", stream: true }),
    });
    expect(wrongModel.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});

it("allows more than 128 model requests on one unlimited Run capability", async () => {
  const upstream = vi.fn<typeof fetch>(
    async () =>
      new Response('data: {"type":"response.completed","response":{"id":"done"}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  const gateway = new TenantModelGateway({
    host: "127.0.0.1",
    port: 0,
    advertisedBaseUrl: "http://worker:4200",
    providerGatewayBaseUrl: "http://provider-gateway:8317",
    providerGatewayApiKey: PROVIDER_GATEWAY_KEY,
    maximumRequestsPerTurn: null,
    fetchImplementation: upstream,
  });
  gateways.push(gateway);
  await gateway.start();
  const lease = gateway.issue(command("openai-codex", "gpt-6-luna"));
  for (let n = 0; n < 129; n++) {
    const response = await fetch(`http://127.0.0.1:${gateway.listeningPort}/codex/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.runtime.capability}`,
        "content-type": "application/json",
        ...samplingHeaders(),
      },
      body: JSON.stringify({ model: "gpt-6-luna", stream: true, input: [] }),
    });
    expect(response.status).toBe(200);
    await response.text();
  }
  expect(upstream).toHaveBeenCalledTimes(129);
  await lease.release();
});
