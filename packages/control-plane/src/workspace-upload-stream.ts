import { createHash } from "node:crypto";
import type { UploadContent } from "@pi-cloud/protocol";

/** Peek only a signature, preserving the original bytes and backpressure. */
export async function sniffUpload(chunks: AsyncIterable<Uint8Array>) {
  const iterator = chunks[Symbol.asyncIterator]();
  const prefix: Buffer[] = [];
  const pending: Uint8Array[] = [];
  let size = 0;
  let closing: Promise<unknown> | undefined;
  const close = () => (closing ??= Promise.resolve(iterator.return?.()).catch(() => {}));
  try {
    while (size < 12) {
      const next = await iterator.next();
      if (next.done) break;
      pending.push(next.value);
      const head = Buffer.from(next.value.subarray(0, 12 - size));
      prefix.push(head);
      size += head.length;
    }
  } catch (error) {
    await close();
    throw error;
  }
  return {
    close,
    prefix: Buffer.concat(prefix),
    chunks: (async function* () {
      try {
        yield* pending;
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          yield next.value;
        }
      } finally {
        await close();
      }
    })(),
  };
}

/** No full-file buffer: only time spent waiting for a demanded chunk is idle. */
export async function* verifiedUpload(
  content: UploadContent,
  signal: AbortSignal,
  idleMs = 60000,
): AsyncGenerator<Uint8Array> {
  const iterator = content.chunks[Symbol.asyncIterator]();
  const hash = createHash("sha256");
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: () => void = () => {};
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("Upload cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(
          () => reject(new Error("Upload stream stopped making progress")),
          idleMs,
        );
        timer.unref();
      });
      let item: IteratorResult<Uint8Array>;
      try {
        item = await Promise.race([iterator.next(), interrupted]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) throw new Error("Invalid upload chunk");
      if (!item.value.byteLength) continue;
      total += item.value.byteLength;
      if (total > content.byteLength) throw new Error("Upload exceeds its declared Content-Length");
      hash.update(item.value);
      yield item.value;
    }
    if (total !== content.byteLength || hash.digest("hex") !== content.sha256)
      throw new Error("Upload content does not match its declared digest");
  } finally {
    void iterator.return?.().catch(() => {});
  }
}
