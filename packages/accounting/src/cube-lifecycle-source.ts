import { parseSandboxLifecyclePage, type SandboxLifecycleCursor } from "@pi-cloud/protocol";
import type { SandboxLifecycleSource } from "./lifecycle-source.ts";

/** Cube wire names end at this adapter. Closed providers can implement the same
 * history/coverage contract without a PiCloud guest or billing extension. */
export class CubeLifecycleSource implements SandboxLifecycleSource {
  readonly id: string;
  constructor(readonly options: { id: string; url: string; apiKey: string; fetch?: typeof fetch }) {
    this.id = options.id;
  }
  async #request(action: "sources" | "history", body: unknown, signal: AbortSignal) {
    const response = await (this.options.fetch ?? fetch)(
      new URL(`/lifecycle/${action}`, this.options.url),
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(28_000)]),
        headers: { "X-API-Key": this.options.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Lifecycle source unavailable");
    }
    if (!response.body) throw new Error("Lifecycle source returned no history");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const part of response.body) {
      bytes += part.length;
      if (bytes > 1024 * 1024) throw new Error("Lifecycle page exceeded its bound");
      chunks.push(Buffer.from(part));
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString()) as unknown;
  }
  async list(signal: AbortSignal) {
    const value = (await this.#request("sources", {}, signal)) as {
      sources?: Array<{ nodeID: string; available: boolean }>;
    };
    if (
      !Array.isArray(value.sources) ||
      value.sources.length > 10000 ||
      value.sources.some(
        (s) =>
          !s ||
          typeof s.nodeID !== "string" ||
          !s.nodeID ||
          s.nodeID.length > 128 ||
          typeof s.available !== "boolean",
      )
    )
      throw new Error("Invalid lifecycle source inventory");
    return value.sources.map((s) => ({ id: s.nodeID, available: s.available }));
  }
  async read(
    id: string,
    cursor: SandboxLifecycleCursor | undefined,
    signal: AbortSignal,
    waitMs = 0,
  ) {
    return parseSandboxLifecyclePage(
      await this.#request(
        "history",
        {
          nodeID: id,
          epoch: cursor?.epoch ?? "",
          after: cursor?.sequence ?? "0",
          limit: 128,
          waitMs,
        },
        signal,
      ),
    );
  }
}
