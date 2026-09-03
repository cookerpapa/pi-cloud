import {
  createExecutionLease,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  modelSamplingHeaders,
  type ExecuteTurnCommandMessage,
} from "@pi-cloud/protocol";
import { zstdCompressSync } from "node:zlib";
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
    | "gpt-5.6-luna"
    | "gpt-5.6-terra"
    | "gpt-5.6-sol" = "deepseek-v4-flash",
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
      piSession: { id: "10000000-0000-4000-8000-000000000005", lane: "main" },
      runId: "10000000-0000-4000-8000-000000000006",
      turnId: "10000000-0000-4000-8000-000000000007",
      agentId: "root",
      executionLease: createExecutionLease(
        "10000000-0000-4000-8000-000000000008",
        "10000000-0000-4000-8000-000000000009",
        1,
      ),
      nextEventSeq: 1,
      agent: {
        revisionId: "10000000-0000-4000-8000-000000000010",
        definitionKey: "pi-coding",
        runtimeKind: "pi_sdk",
        runtimeVersion: "0.84.1",
        harnessVersion: "pi-cloud-harness-v1",
        sessionStorageKind: "pi_session_storage_v1",
      },
      input: { kind: "prompt", text: "hello" },
      executionMode: "elastic",
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
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

function createGateway(fetchImplementation: typeof fetch, maximumRequestsPerTurn = 8) {
  const gateway = new TenantModelGateway({
    host: "127.0.0.1",
    port: 0,
    advertisedBaseUrl: "http://pi-worker:4200",
    providerGatewayBaseUrl: "http://provider-gateway:8317",
    providerGatewayApiKey: PROVIDER_GATEWAY_KEY,
    maximumRequestsPerTurn,
    fetchImplementation,
  });
  gateways.push(gateway);
  return gateway;
}

describe("tenant model gateway", () => {
  it("enforces a Turn capability and forwards native DeepSeek Responses with stable Session affinity", async () => {
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://provider-gateway:8317/v1/responses");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${PROVIDER_GATEWAY_KEY}`);
      expect(headers.get("session-id")).toBe(command().payload.sessionId);
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
      inputModalities: ["text"],
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
      body: JSON.stringify({ model: "deepseek-v4-flash", stream: true, input: [] }),
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
    const lease = gateway.issue(command("openai-codex", "gpt-5.6-terra"));
    expect(lease.runtime).toMatchObject({
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "http://pi-worker:4200",
      inputModalities: ["text", "image"],
      hostedTools: ["web_search"],
    });
    const body = zstdCompressSync(
      Buffer.from(JSON.stringify({ model: "gpt-5.6-terra", stream: true, input: [] })),
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
    const lease = gateway.issue(command("openai-codex", "gpt-5.6-sol", "fast"));
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
        model: "gpt-5.6-sol",
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
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: [] }),
    });
    expect(rejected.status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("observes Hosted Web Search progress without changing the Provider stream", async () => {
    const stream = [
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"ws-1","type":"web_search_call","status":"in_progress"}}\n\n',
      'data: {"type":"response.web_search_call.searching","item_id":"ws-1"}\n\n',
      'data: {"type":"response.web_search_call.completed","item_id":"ws-1"}\n\n',
      'data: {"type":"response.output_text.delta","output_index":1,"delta":"found"}\n\n',
      'data: {"type":"response.completed","response":{"id":"r1","output":[{"id":"ws-1","type":"web_search_call","status":"completed","action":{"type":"search","query":"official source"}},{"id":"msg-1","type":"message","content":[{"type":"output_text","text":"found","annotations":[] }]}]}}\n\n',
    ].join("");
    const gateway = createGateway(
      vi.fn<typeof fetch>(async () =>
        Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      ),
    );
    await gateway.start();
    const lease = gateway.issue(command("openai-codex", "gpt-5.6-luna"));
    const activities: unknown[] = [];
    const transcripts: unknown[] = [];
    lease.subscribeHostedActivity?.((activity) => activities.push(activity));
    lease.subscribeHostedTranscript?.((transcript) => transcripts.push(transcript));

    const headers = samplingHeaders();

    const response = await fetch(
      `http://127.0.0.1:${String(gateway.listeningPort)}/codex/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${lease.runtime.capability}`,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ model: "gpt-5.6-luna", stream: true, input: [] }),
      },
    );

    expect(await response.text()).toBe(stream);
    expect(activities).toEqual([
      { phase: "started", toolName: "web_search", activityId: "ws-1" },
      {
        phase: "completed",
        toolName: "web_search",
        activityId: "ws-1",
        outcome: "completed",
        action: { type: "search", queries: ["official source"] },
      },
    ]);
    expect(transcripts).toEqual([
      expect.objectContaining({
        provider: "openai-codex",
        api: "openai-codex-responses",
        modelId: "gpt-5.6-luna",
        stepSequence: Number(headers["x-pi-cloud-step-sequence"]),
        stepSha256: headers["x-pi-cloud-step-sha256"],
        samplingAttempt: 1,
        items: [
          expect.objectContaining({ type: "web_search_call", id: "ws-1" }),
          expect.objectContaining({ type: "message", id: "msg-1" }),
        ],
      }),
    ]);
  });

  it("retries only a pre-stream Provider Gateway transport failure", async () => {
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
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("recovered");
    expect(upstream).toHaveBeenCalledTimes(2);
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

  it("uses Provider Gateway health as the Run-claim readiness dependency", async () => {
    const upstream = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("http://provider-gateway:8317/healthz");
      return new Response(null, { status: 200 });
    });
    const gateway = createGateway(upstream);
    await gateway.start();
    await expect(gateway.checkProviderHealth()).resolves.toBeUndefined();
  });
});
