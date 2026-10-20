import {
  createRegistry,
  Harness,
  MemoryStorage,
  configure,
  type Storage,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { zstdDecompressSync } from "node:zlib";
import { modelSamplingHeaders } from "@pi-cloud/protocol";
import { PiCloudMetrics } from "@pi-cloud/observability";
import { TenantModelGateway } from "../../../supervisor-host/src/model-gateway.ts";
import { CloudModelRegistry } from "../../src/durable/model-registry.ts";
import { ScopedDurableModels } from "../../src/durable/scoped-models.ts";
import {
  nativeProviderContext,
  replayProviderHostedTranscripts,
} from "../../src/provider-hosted-transcript.ts";
import { command as seed } from "./durable-command.ts";

export const frames = (...values: unknown[]) =>
  values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
export const created = {
  type: "response.created",
  response: { id: "response-1", status: "in_progress" },
};
export const textItem = (id: string, phase: string, text = "") => ({
  type: "message",
  id,
  phase,
  role: "assistant",
  status: "completed",
  content: text ? [{ type: "output_text", text, annotations: [] }] : [],
});
export const added = (item: unknown, index: number) => ({
  type: "response.output_item.added",
  output_index: index,
  item,
});
export const done = (item: unknown, index: number) => ({
  type: "response.output_item.done",
  output_index: index,
  item,
});
export const delta = (index: number, text: string) => ({
  type: "response.output_text.delta",
  output_index: index,
  content_index: 0,
  delta: text,
});
export const terminal = (items: unknown[]) => ({
  type: "response.completed",
  response: {
    id: "response-1",
    status: "completed",
    output: items,
    usage: {
      input_tokens: 8,
      output_tokens: 3,
      total_tokens: 11,
      input_tokens_details: { cached_tokens: 0 },
    },
  },
});
export function success() {
  const item = textItem("final", "final_answer", "done");
  return new Response(
    frames(
      created,
      added(textItem("final", "final_answer"), 0),
      delta(0, "done"),
      done(item, 0),
      terminal([item]),
    ),
    { headers: { "content-type": "text/event-stream" } },
  );
}
export function controlled(signal: AbortSignal) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const abort = () => {
    try {
      controller.error(new Error("synthetic upstream stopped"));
    } catch {}
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener("abort", abort, { once: true });
    },
    cancel() {
      signal.removeEventListener("abort", abort);
    },
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    send: (...values: unknown[]) => controller.enqueue(new TextEncoder().encode(frames(...values))),
    end: () => {
      signal.removeEventListener("abort", abort);
      controller.close();
    },
    fail: () => {
      signal.removeEventListener("abort", abort);
      controller.error(new Error("synthetic connection reset"));
    },
  };
}

export async function modelHttpFixture(
  provider: "openai-codex" | "deepseek",
  upstream: (attempt: number, signal: AbortSignal) => Response | Promise<Response>,
  options: { maximumRequests?: number } = {},
) {
  const owner = new AbortController(),
    metrics = new PiCloudMetrics("model-contract");
  const payloads: Record<string, unknown>[] = [];
  const outcomes: { outcome: string; durationMs: number }[] = [];
  let releases = 0,
    sequence = 0;
  const gateway = new TenantModelGateway({
    host: "127.0.0.1",
    port: 0,
    advertisedBaseUrl: "http://127.0.0.1",
    providerGatewayBaseUrl: "http://unused.invalid",
    providerGatewayApiKey: "fixture-".padEnd(48, "x"),
    upstreamConnectTimeoutMs: 1000,
    upstreamIdleTimeoutMs: 3000,
    metrics,
    ...(options.maximumRequests === undefined
      ? {}
      : { maximumRequestsPerTurn: options.maximumRequests }),
    fetchImplementation: async (_url, init) => {
      const body = Buffer.from(init!.body as Uint8Array);
      const bytes =
        new Headers(init?.headers).get("content-encoding") === "zstd"
          ? zstdDecompressSync(body)
          : body;
      payloads.push(JSON.parse(bytes.toString("utf8")) as Record<string, unknown>);
      return upstream(payloads.length, init!.signal!);
    },
  });
  await gateway.start();
  const command = structuredClone(seed);
  command.payload.tenantId = "10000000-0000-4000-8000-000000000001";
  command.payload.sessionId = "10000000-0000-4000-8000-000000000002";
  command.payload.piSession.id = command.payload.sessionId;
  command.payload.model.provider = provider;
  command.payload.model.modelId = provider === "deepseek" ? "deepseek-v4-flash" : "gpt-6-luna";
  const lease = gateway.issue(command, owner.signal);
  const registry = new CloudModelRegistry();
  const model = registry.configure({
    ...lease.runtime,
    apiKey: lease.runtime.capability,
    baseUrl: `http://127.0.0.1:${gateway.listeningPort}${provider === "deepseek" ? "/v1" : ""}`,
  });
  const scoped = new ScopedDurableModels(registry.models, async (request) => {
    const input = request.input as Context;
    const signal = request.options.signal
      ? AbortSignal.any([owner.signal, request.options.signal])
      : owner.signal;
    signal.throwIfAborted();
    return {
      model,
      input: nativeProviderContext(input, model),
      options: {
        ...request.options,
        signal,
        apiKey: lease.runtime.capability,
        transport: "sse",
        timeoutMs: 2000,
        headers: modelSamplingHeaders({
          stepSequence: ++sequence,
          stepSha256: "a".repeat(64),
          samplingAttempt: sequence,
        }),
        onPayload: (payload: unknown) => replayProviderHostedTranscripts(payload, input, model),
      },
      release() {
        releases++;
      },
      onOutcome(sample) {
        outcomes.push(sample);
        metrics.modelDuration.observe(
          { provider, model: model.id, outcome: sample.outcome },
          sample.durationMs / 1000,
        );
      },
    };
  });
  const route = scoped.register(command.payload.runId, 1, model);
  return {
    gateway,
    owner,
    model,
    metrics,
    outcomes,
    payloads,
    scoped,
    route,
    releases: () => releases,
    async run(
      context: Context = { messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
    ) {
      const events: AssistantMessageEvent[] = [];
      const stream = scoped.models.streamSimple(
        scoped.models.getModel(route.provider, route.modelId)!,
        context,
      );
      for await (const event of stream) events.push(structuredClone(event));
      return { result: await stream.result(), events };
    },
    async harness(storage: Storage = new MemoryStorage(), retries = 1) {
      const harness = await Harness.open(
        storage,
        {
          models: scoped.models,
          registry: createRegistry(),
          settings: {
            compaction: { enabled: false },
            retry: { maxRetries: retries, baseDelayMs: 1 },
          },
        },
        BACKGROUND_CONTEXT,
      );
      const root = await harness.root(BACKGROUND_CONTEXT);
      await root.commit((tx) => configure(tx, root.id, { model: route }), BACKGROUND_CONTEXT);
      return { harness, root };
    },
    async close() {
      owner.abort();
      await lease.release();
      await gateway.close();
    },
  };
}

export class JournalStorage extends MemoryStorage {
  readonly journal: StorageWrite[][] = [];
  override async commit(writes: readonly StorageWrite[]) {
    const prepared = this.prepareCommit(writes);
    this.journal.push(structuredClone([...prepared.writes]));
    return prepared.apply();
  }
}
export function assistantMessages(
  entries: readonly { model?: readonly unknown[] }[],
): AssistantMessage[] {
  return entries
    .flatMap((entry) => entry.model ?? [])
    .filter(
      (message): message is AssistantMessage =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "assistant",
    );
}
