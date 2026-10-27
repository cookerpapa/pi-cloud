import { AsyncLocalStorage } from "node:async_hooks";
import WebSocket from "ws";
import {
  encodeModelSocketRequest,
  parseModelSamplingIdentity,
  MODEL_STEP_SEQUENCE_HEADER,
  MODEL_STEP_SHA256_HEADER,
  MODEL_SAMPLING_ATTEMPT_HEADER,
  type ModelSamplingIdentity,
} from "@pi-cloud/protocol";

type Scope = { endpoint: string; sampling: ModelSamplingIdentity };
const requests = new AsyncLocalStorage<Scope>();
type SendData = Parameters<WebSocket["send"]>[0];
type SendOptions = { mask?: boolean; binary?: boolean; compress?: boolean; fin?: boolean };
type Callback = (error?: Error) => void;

/** Pi uses the runtime WebSocket constructor. Node's WHATWG constructor cannot
 * carry its auth headers; use the already pinned Node ws transport. Only a
 * scoped Cloud Models call adds our envelope, after Pi selects full/delta input. */
class ModelWebSocket extends WebSocket {
  readonly #endpoint: string | undefined;
  constructor(address: string | URL, options?: WebSocket.ClientOptions | string | string[]) {
    super(address, options as WebSocket.ClientOptions);
    const scope = requests.getStore();
    if (scope && String(address) === scope.endpoint) this.#endpoint = scope.endpoint;
  }
  override send(data: SendData, callback?: Callback): void;
  override send(data: SendData, options: SendOptions, callback?: Callback): void;
  override send(data: SendData, options?: SendOptions | Callback, callback?: Callback): void {
    if (this.#endpoint) {
      const scope = requests.getStore();
      if (!scope || scope.endpoint !== this.#endpoint || typeof data !== "string")
        throw new Error("Model socket request has no matching active sampling scope");
      data = encodeModelSocketRequest(scope.sampling, data);
    }
    if (typeof options === "function") super.send(data, options);
    else super.send(data, options ?? {}, callback);
  }
}

export function withModelWebSocket<T>(
  model: { api: string; baseUrl: string },
  options: Record<string, unknown>,
  operation: () => T,
): T {
  if (
    model.api !== "openai-codex-responses" ||
    !["auto", "websocket", "websocket-cached"].includes(String(options.transport))
  )
    return operation();
  const headers = new Headers(options.headers as HeadersInit | undefined);
  const sampling = parseModelSamplingIdentity({
    stepSequence: headers.get(MODEL_STEP_SEQUENCE_HEADER),
    stepSha256: headers.get(MODEL_STEP_SHA256_HEADER),
    samplingAttempt: headers.get(MODEL_SAMPLING_ATTEMPT_HEADER),
  });
  const endpoint = new URL(model.baseUrl);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/codex/responses";
  globalThis.WebSocket = ModelWebSocket as unknown as typeof globalThis.WebSocket;
  return requests.run({ endpoint: endpoint.toString(), sampling }, operation);
}
