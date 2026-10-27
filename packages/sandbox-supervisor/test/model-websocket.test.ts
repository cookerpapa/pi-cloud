import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import type { Context, AssistantMessage } from "@earendil-works/pi-ai";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketDebugStats,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import { modelSamplingHeaders, encodeModelSocketRequest } from "@pi-cloud/protocol";
import { fixtureModelRuntime } from "../../../scripts/lib/test-model-catalog.mjs";
import { command as seed } from "./fixtures/durable-command.ts";
import { CloudModelRegistry } from "../src/durable/model-registry.ts";
import { ScopedDurableModels } from "../src/durable/scoped-models.ts";
import { frames, created, textItem, added, done, delta, terminal } from "./fixtures/model-http.ts";
import { TenantModelGateway } from "../../supervisor-host/src/model-gateway.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});
type Request = Record<string, any>;
const identity = (n: number) => ({
  stepSequence: n,
  stepSha256: n.toString(16).padStart(64, "0"),
  samplingAttempt: 1,
});
const image = {
  type: "image" as const,
  mimeType: "image/png",
  data: Buffer.alloc(256 * 1024, 37).toString("base64"),
};
const context = (): Context => ({
  systemPrompt: "Inspect the image with a tool.",
  tools: [{ name: "read", description: "Read a test fixture", parameters: Type.Object({}) }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Inspect this image" }, image], timestamp: 1 },
  ],
});

function respond(socket: WebSocket, call = false, responseId = "response-1") {
  const item = call
    ? {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "read",
        arguments: "{}",
        status: "completed",
      }
    : textItem("final", "final_answer", "done");
  const completion = terminal([item]);
  completion.response.id = responseId;
  for (const frame of [
    created,
    added(item, 0),
    ...(!call ? [delta(0, "done")] : []),
    done(item, 0),
    completion,
  ])
    socket.send(JSON.stringify(frame));
}

async function fixture(
  options: { rejectUpgrade?: boolean; maximumRequests?: number; idleMs?: number } = {},
) {
  const payloads: Request[] = [],
    headers: Record<string, unknown>[] = [],
    peers: WebSocket[] = [],
    samples: Record<string, unknown>[] = [];
  let httpRequests = 0;
  const server = createServer((_request, response) => {
    httpRequests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const item = textItem("fallback", "final_answer", "fallback");
    response.end(
      frames(created, added(item, 0), delta(0, "fallback"), done(item, 0), terminal([item])),
    );
  });
  const ws = new WebSocketServer({ noServer: true });
  let handle = (_body: Request, peer: WebSocket) => respond(peer, payloads.length === 1);
  server.on("upgrade", (request, socket, head) => {
    if (options.rejectUpgrade) {
      socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    ws.handleUpgrade(request, socket, head, (peer) => {
      headers.push(request.headers);
      peers.push(peer);
      peer.on("error", () => {});
      peer.on("message", (raw) => {
        const body = JSON.parse(raw.toString()) as Request;
        payloads.push(body);
        handle(body, peer);
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const gateway = new TenantModelGateway({
    host: "127.0.0.1",
    port: 0,
    advertisedBaseUrl: "http://127.0.0.1",
    providerGatewayBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    providerGatewayApiKey: "fixture-provider-secret".padEnd(48, "x"),
    connectTimeoutMs: 1000,
    ...(options.maximumRequests === undefined
      ? {}
      : { maximumRequestsPerTurn: options.maximumRequests }),
  });
  await gateway.start();
  const command = structuredClone(seed);
  command.payload.model = {
    ...command.payload.model,
    provider: "openai-codex",
    modelId: "gpt-6-luna",
    thinkingLevel: "low",
    runtime: fixtureModelRuntime("openai-codex", "gpt-6-luna"),
  };
  const owner = new AbortController(),
    grant = gateway.issue(command, owner.signal);
  const registry = new CloudModelRegistry();
  const model = registry.configure({
    provider: "openai-codex",
    modelId: "gpt-6-luna",
    api: "openai-codex-responses",
    baseUrl: `http://127.0.0.1:${gateway.listeningPort}`,
    apiKey: grant.runtime.capability,
    transport: "auto",
    inputModalities: ["text", "image"],
  });
  const scoped = new ScopedDurableModels(registry.models, async (request) => ({
    model,
    options: request.options,
    eventIdleTimeoutMs: options.idleMs ?? 2000,
    release: () => {},
  }));
  const ref = scoped.register(command.payload.runId, 1, model);
  const reference = scoped.models.getModel(ref.provider, ref.modelId)!;
  const scopes = new Set<string>(),
    defaultScope = randomUUID();
  const log = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    try {
      const event = JSON.parse(String(chunk));
      if (event.event === "model.transport.timing") samples.push(event.attributes);
    } catch {}
    return true;
  }) as typeof process.stdout.write);
  disposers.push(async () => {
    for (const key of scopes) {
      closeOpenAICodexWebSocketSessions(key);
      resetOpenAICodexWebSocketDebugStats(key);
    }
    grant.release();
    await gateway.close();
    for (const peer of peers) peer.terminate();
    ws.close();
    server.close();
    await once(server, "close");
    log.mockRestore();
  });
  return {
    gateway,
    grant,
    owner,
    payloads,
    peers,
    headers,
    samples,
    setHandle: (next: typeof handle) => {
      handle = next;
    },
    httpRequests: () => httpRequests,
    sample(input: Context, sequence = 1, key: string = defaultScope, signal?: AbortSignal) {
      scopes.add(key);
      return scoped.models.completeSimple(reference, input, {
        apiKey: grant.runtime.capability,
        transport: "auto",
        sessionId: key,
        headers: modelSamplingHeaders(identity(sequence)),
        websocketConnectTimeoutMs: 1000,
        ...(signal ? { signal } : {}),
      });
    },
    async raw() {
      const peer = new WebSocket(`ws://127.0.0.1:${gateway.listeningPort}/codex/responses`, {
        headers: { authorization: "Bearer " + grant.runtime.capability },
      });
      peer.on("error", () => {});
      await once(peer, "open");
      return peer;
    },
  };
}

function afterTool(input: Context, first: AssistantMessage): Context {
  const call = first.content.find((c) => c.type === "toolCall")!;
  if (call.type !== "toolCall") throw new Error("Missing Tool call");
  return {
    ...input,
    messages: [
      ...input.messages,
      first,
      {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: "read result" }],
        isError: false,
        timestamp: 2,
      },
    ],
  };
}

it("uses native Pi continuation without repeating images and records each request's own sampling", async () => {
  const f = await fixture(),
    input = context();
  const first = await f.sample(input, 1);
  expect(first.stopReason).toBe("toolUse");
  const second = await f.sample(afterTool(input, first), 2);
  expect(second.stopReason).toBe("stop");
  expect(f.payloads).toHaveLength(2);
  expect(f.peers).toHaveLength(1);
  expect(f.payloads[1]!.previous_response_id).toBe("response-1");
  expect(f.payloads[1]!.input).toEqual([
    { type: "function_call_output", call_id: "call_1", output: "read result" },
  ]);
  expect(JSON.stringify(f.payloads[1])).not.toContain("base64");
  expect(f.samples.map((s) => s.stepSequence)).toEqual([1, 2]);
  expect(f.samples.map((s) => s.incremental)).toEqual([false, true]);
  expect(f.samples.map((s) => s.terminalEvent)).toEqual([
    "response.completed",
    "response.completed",
  ]);
  expect(Number(f.samples[1]!.requestBytes)).toBeLessThan(Number(f.samples[0]!.requestBytes) / 100);
  expect(f.headers[0]!.authorization).not.toContain(f.grant.runtime.capability);
  expect(JSON.stringify(f.payloads)).not.toContain("stepSha256");
  expect(JSON.stringify(f.samples)).not.toContain(image.data);
});

it("starts fresh input after a connection is lost between rounds", async () => {
  const f = await fixture(),
    input = context(),
    first = await f.sample(input);
  f.peers[0]!.terminate();
  await new Promise((r) => setTimeout(r, 30));
  expect((await f.sample(afterTool(input, first), 2)).stopReason).toBe("stop");
  expect(f.peers).toHaveLength(2);
  expect(f.payloads[1]!.previous_response_id).toBeUndefined();
  expect(JSON.stringify(f.payloads[1])).toContain(image.data);
});

it("replaces changed context and keeps parallel conversation caches separate", async () => {
  const f = await fixture();
  f.setHandle((_body, peer) => respond(peer));
  const a = context(),
    b = { ...context(), systemPrompt: "Independent summary context" };
  const [ra, rb] = await Promise.all([
    f.sample(a, 10, "agent-" + randomUUID()),
    f.sample(b, 20, "summary-" + randomUUID()),
  ]);
  expect([ra.stopReason, rb.stopReason]).toEqual(["stop", "stop"]);
  expect(f.peers).toHaveLength(2);
  expect(f.payloads.every((p) => !p.previous_response_id)).toBe(true);
  expect(f.samples.map((s) => s.stepSequence).sort()).toEqual([10, 20]);
  const first = await f.sample(a, 30);
  await f.sample(
    {
      ...a,
      systemPrompt: "Changed tools/instructions",
      messages: [...a.messages, first, { role: "user", content: "continue", timestamp: 3 }],
    },
    31,
  );
  expect(f.payloads.at(-1)!.previous_response_id).toBeUndefined();
});

it("recovers a missing previous response with one native full-context request", async () => {
  const f = await fixture(),
    input = context(),
    first = await f.sample(input);
  let missing = true;
  f.setHandle((body, peer) => {
    if (body.previous_response_id && missing) {
      missing = false;
      peer.send(
        JSON.stringify({
          type: "error",
          code: "previous_response_not_found",
          message: "Previous response not found",
          error: { code: "previous_response_not_found", message: "Previous response not found" },
        }),
      );
    } else respond(peer);
  });
  expect((await f.sample(afterTool(input, first), 2)).stopReason).toBe("stop");
  expect(f.payloads).toHaveLength(3);
  expect(f.payloads[2]!.previous_response_id).toBeUndefined();
  expect(JSON.stringify(f.payloads[2])).toContain(image.data);
});

it("falls back through native SSE when upstream rejects the WebSocket upgrade", async () => {
  const f = await fixture({ rejectUpgrade: true });
  expect((await f.sample(context())).stopReason).toBe("stop");
  expect(f.httpRequests()).toBe(1);
  expect(f.payloads).toHaveLength(0);
});

it.each(["stop", "owner", "idle"] as const)(
  "closes unfinished output on %s without exposing partial Tool calls",
  async (reason) => {
    const f = await fixture({ idleMs: 100 }),
      stop = new AbortController();
    f.setHandle((_body, peer) => {
      peer.send(JSON.stringify(created));
      peer.send(
        JSON.stringify(
          added(
            {
              type: "function_call",
              id: "fc_half",
              call_id: "call_half",
              name: "read",
              arguments: "",
            },
            0,
          ),
        ),
      );
      peer.send(
        JSON.stringify({
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: '{"path":',
        }),
      );
      if (reason !== "idle")
        setTimeout(() => (reason === "stop" ? stop.abort() : f.owner.abort()), 20);
    });
    const result = await f.sample(context(), 1, randomUUID(), stop.signal);
    expect(result.stopReason).toBe(reason === "stop" ? "aborted" : "error");
    expect(result.content.some((c) => c.type === "toolCall")).toBe(false);
    await vi.waitFor(() =>
      expect(f.peers.every((p) => p.readyState === WebSocket.CLOSED)).toBe(true),
    );
  },
);

it("rejects changed model, malformed frames and excess requests before provider dispatch", async () => {
  const f = await fixture({ maximumRequests: 1 });
  const raw = await f.raw();
  const message = once(raw, "message");
  raw.send(
    encodeModelSocketRequest(
      identity(1),
      JSON.stringify({ type: "response.create", model: "other" }),
    ),
  );
  expect(JSON.parse(String((await message)[0])).type).toBe("error");
  expect(f.payloads).toHaveLength(0);
  expect((await f.sample(context())).stopReason).toBe("toolUse");
  expect((await f.sample(context(), 2)).stopReason).toBe("error");
  expect(f.payloads).toHaveLength(1);
});
