import { Agent, fetch as internalFetch } from "undici";

export type GenerationImage = { data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" };
export class ImageGenerationError extends Error {
  constructor(
    readonly uncertain: boolean,
    message: string,
  ) {
    super(message);
  }
}
type Request = {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
};

function errorText(value: unknown, apiKey: string, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = (apiKey ? value.replaceAll(apiKey, "[redacted]") : value)
    .replace(/data:[^\s"'<>]+/gi, "[image data omitted]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[\w-]+/g, "[redacted]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[^\s"',;]+/gi,
      "$1=[redacted]",
    )
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim();
  return text ? text.slice(0, limit) : undefined;
}

/** Error bodies are diagnostics, not image payloads or an additional retry path. */
async function serviceErrorDetail(
  response: Response,
  apiKey: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  let discarded = false;
  const cancel = () => {
    discarded = true;
    void reader.cancel().catch(() => undefined);
  };
  const timer = setTimeout(cancel, 5_000);
  timer.unref();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (discarded) return undefined;
      if (done) break;
      length += value.length;
      if (length > 64 * 1024) return undefined;
      chunks.push(value);
    }
    const { error } = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
    const detail = {
      code: errorText(error.code, apiKey, 128),
      type: errorText(error.type, apiKey, 128),
      message: errorText(error.message, apiKey, 2_000),
      parameter: errorText(error.param, apiKey, 128),
      moderationStage: errorText(error.moderation_details?.moderation_stage, apiKey, 64),
      moderationCategories: Array.isArray(error.moderation_details?.categories)
        ? error.moderation_details.categories
            .slice(0, 8)
            .map((value: unknown) => errorText(value, apiKey, 64))
            .filter(Boolean)
        : undefined,
    };
    return Object.values(detail).some((value) => value && value.length > 0)
      ? JSON.stringify(detail)
      : undefined;
  } catch {
    signal.throwIfAborted();
    return undefined;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
  }
}

/** One Images request, with no model retry or fallback to another credential route. */
export class ImageGenerationClient {
  readonly #agent = new Agent({ headersTimeout: 300_000, bodyTimeout: 300_000 });
  constructor(
    readonly options: {
      baseUrl: string;
      apiKey: string;
      model: string;
      fetch?: (url: string, request: Request) => Promise<Response>;
    },
  ) {}
  async close(): Promise<void> {
    await this.#agent.destroy();
  }
  async generate(
    input: { prompt: string; images: GenerationImage[]; transparent: boolean },
    signal: AbortSignal,
  ): Promise<GenerationImage> {
    signal.throwIfAborted();
    const request = {
      model: this.options.model,
      prompt: input.prompt,
      background: input.transparent ? "transparent" : "opaque",
      size: "auto",
      quality: "auto",
      n: 1,
      output_format: "png",
      ...(input.images.length
        ? {
            images: input.images.map((image) => ({
              image_url: `data:${image.mimeType};base64,${image.data}`,
            })),
          }
        : {}),
    };
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/v1/images/${input.images.length ? "edits" : "generations"}`;
    const send =
      this.options.fetch ??
      (async (url: string, init: Request) =>
        (await internalFetch(url, {
          ...init,
          dispatcher: this.#agent,
          redirect: "error",
        })) as unknown as Response);
    let response: Response;
    try {
      response = await send(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
      });
    } catch {
      signal.throwIfAborted();
      throw new ImageGenerationError(
        true,
        "The image request ended without a confirmed response. It was not retried.",
      );
    }
    if (!response.ok) {
      const detail = await serviceErrorDetail(response, this.options.apiKey, signal);
      signal.throwIfAborted();
      throw new ImageGenerationError(
        response.status >= 500 || response.status === 408,
        `Image service returned HTTP ${response.status}.${detail ? ` Provider error: ${detail}.` : ""} No automatic retry was sent.`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ImageGenerationError(true, "Image service returned no response body.");
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 96 * 1024 * 1024)
          throw new Error("Image transport response exceeded its byte budget");
        chunks.push(Buffer.from(value));
      }
      const body = JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as {
        data?: { b64_json?: string }[];
      };
      const data = body.data?.[0]?.b64_json;
      if (!data || body.data?.length !== 1)
        throw new Error("Image service returned no single image");
      const bytes = Buffer.from(data, "base64");
      if (
        !bytes.length ||
        bytes.length > 64 * 1024 * 1024 ||
        bytes.toString("base64") !== data ||
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new Error("Image service did not return a bounded PNG");
      return { data, mimeType: "image/png" };
    } catch {
      signal.throwIfAborted();
      throw new ImageGenerationError(
        true,
        "The image service response could not be received or validated. Do not assume generation did not occur.",
      );
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
