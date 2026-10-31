import { createHash } from "node:crypto";
import {
  IMAGE_OPAQUE_FIELDS,
  parseImageAttachmentReference,
  type ImageAttachmentReference,
  type ImagePacked,
} from "@pi-cloud/protocol";

export type ImageScope = { tenantId: string; runId?: string };
export type ImageReadObserver = () =>
  | ((sample: {
      durationMs: number;
      byteLength: number;
      outcome: "completed" | "failed" | "cancelled";
    }) => void)
  | undefined;
export interface ImageAttachmentStore {
  put(
    scope: ImageScope,
    bytes: Buffer,
    mimeType: ImageAttachmentReference["mimeType"],
    signal?: AbortSignal,
  ): Promise<ImageAttachmentReference>;
  get(tenantId: string, reference: ImageAttachmentReference, signal?: AbortSignal): Promise<Buffer>;
}

/** Original objects can be larger than a model image. A scoped consumer keeps
 * their transport streaming and guarantees closure on failure/early return. */
export interface ImageAttachmentSource {
  withStream<T>(
    tenantId: string,
    reference: ImageAttachmentReference,
    consume: (chunks: AsyncIterable<Uint8Array>, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Only serialization changes. Pi receives exact native image content after decoding. */
export class ImageAttachmentCodec {
  // References only, never a completed Tool result or a retained image byte cache.
  readonly #known = new Map<string, ImageAttachmentReference>();
  constructor(
    readonly store: ImageAttachmentStore,
    readonly onImageReadStart?: ImageReadObserver,
  ) {}
  #remember(key: string, ref: ImageAttachmentReference) {
    this.#known.set(key, ref);
    if (this.#known.size > 1024) this.#known.delete(this.#known.keys().next().value!);
  }
  async pack<T>(scope: ImageScope, value: T, signal?: AbortSignal): Promise<ImagePacked<T>> {
    const visit = async (part: unknown): Promise<unknown> => {
      signal?.throwIfAborted();
      if (Array.isArray(part)) {
        const out = [];
        for (const p of part) out.push(await visit(p));
        return out;
      }
      if (!object(part)) return part;
      if (part.type === "pi_cloud_image_v1")
        throw new Error("An attachment reference cannot originate in native Tool content");
      if (
        part.type === "image" &&
        typeof part.data === "string" &&
        typeof part.mimeType === "string"
      ) {
        if (!["image/png", "image/jpeg", "image/webp"].includes(part.mimeType))
          throw new Error("Image must be normalized before attachment upload");
        if (part.data.length % 4 !== 0) throw new Error("Invalid or oversized image content");
        const bytes = Buffer.from(part.data, "base64");
        if (!bytes.length || bytes.toString("base64") !== part.data)
          throw new Error("Invalid or oversized image content");
        const sha = createHash("sha256").update(bytes).digest("hex");
        const key = `${scope.tenantId}:${scope.runId ?? "cold"}:${part.mimeType}:${sha}`;
        const ref =
          (scope.runId ? this.#known.get(key) : undefined) ??
          (await this.store.put(
            scope,
            bytes,
            part.mimeType as ImageAttachmentReference["mimeType"],
            signal,
          ));
        if (scope.runId) this.#remember(key, ref);
        const { type: _type, data: _data, mimeType: _mime, ...rest } = part;
        return { ...rest, type: "pi_cloud_image_v1", attachment: ref };
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(part))
        Object.defineProperty(out, k, {
          value: IMAGE_OPAQUE_FIELDS.has(k) ? structuredClone(v) : await visit(v),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      return out;
    };
    return (await visit(value)) as ImagePacked<T>;
  }
  async unpack<T>(scope: ImageScope, value: ImagePacked<T>, signal?: AbortSignal): Promise<T> {
    // Only this decode owns the bytes. A later request must revalidate storage.
    const images = new Map<string, Promise<string>>();
    const visit = async (part: unknown): Promise<unknown> => {
      signal?.throwIfAborted();
      if (Array.isArray(part)) {
        const out = [];
        for (const p of part) out.push(await visit(p));
        return out;
      }
      if (!object(part)) return part;
      if (part.type === "pi_cloud_image_v1") {
        const ref = parseImageAttachmentReference(part.attachment);
        const key = JSON.stringify([
          scope.tenantId,
          ref.id,
          ref.sha256,
          ref.mimeType,
          ref.byteLength,
        ]);
        let pending = images.get(key);
        if (!pending) {
          pending = (async () => {
            let observe: ReturnType<ImageReadObserver>;
            try {
              observe = this.onImageReadStart?.();
            } catch {
              /* optional observation */
            }
            const started = observe ? performance.now() : 0;
            let byteLength = 0;
            let outcome: "completed" | "failed" | "cancelled" = "failed";
            try {
              const bytes = await this.store.get(scope.tenantId, ref, signal);
              byteLength = bytes.length;
              signal?.throwIfAborted();
              if (
                bytes.length !== ref.byteLength ||
                createHash("sha256").update(bytes).digest("hex") !== ref.sha256
              )
                throw new Error("Image attachment integrity check failed");
              const data = bytes.toString("base64");
              outcome = "completed";
              return data;
            } catch (error) {
              if (signal?.aborted) outcome = "cancelled";
              throw error;
            } finally {
              try {
                observe?.({ durationMs: performance.now() - started, byteLength, outcome });
              } catch {
                /* preserve original outcome */
              }
            }
          })();
          images.set(key, pending);
        }
        const data = await pending;
        signal?.throwIfAborted();
        if (scope.runId)
          this.#remember(`${scope.tenantId}:${scope.runId}:${ref.mimeType}:${ref.sha256}`, ref);
        const { type: _type, attachment: _attachment, ...rest } = part;
        return { ...rest, type: "image", data, mimeType: ref.mimeType };
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(part))
        Object.defineProperty(out, k, {
          value: IMAGE_OPAQUE_FIELDS.has(k) ? structuredClone(v) : await visit(v),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      return out;
    };
    return (await visit(value)) as T;
  }
}

/** Upload ingress uses a stream; native Pi image parts retain the Buffer API above. */
export interface ImageUploadStore {
  putStream(
    scope: { tenantId: string; uploadId: string; claimToken: string },
    content: import("@pi-cloud/protocol").UploadContent,
    mimeType: ImageAttachmentReference["mimeType"],
    signal: AbortSignal,
  ): Promise<ImageAttachmentReference>;
}
