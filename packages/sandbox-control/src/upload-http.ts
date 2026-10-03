import { Agent, fetch, type Response } from "undici";
import { uploadContentDigest } from "@pi-cloud/protocol";
// Application cancellation/idle/receipt timers own the transfer. A fixed headers
// timeout would cut off a large file while its body is still making progress.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
export async function uploadHttp<T>(input: {
  url: URL | string;
  token: string;
  metadata: { sha256: string; byteLength: number };
  chunks: AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
  receiptTimeoutMs: number;
  read: (response: Response) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const progress = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new Error("Upload transport stopped making progress")),
      60_000,
    );
    timer.unref();
  };
  progress();
  const body = (async function* () {
    for await (const chunk of input.chunks) {
      signal.throwIfAborted();
      progress();
      yield chunk;
    }
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new Error("Upload receipt timed out")),
      input.receiptTimeoutMs,
    );
    timer.unref();
  })();
  try {
    const response = await fetch(input.url, {
      dispatcher,
      redirect: "manual",
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/octet-stream",
        "content-length": String(input.metadata.byteLength),
        "content-digest": uploadContentDigest(input.metadata.sha256),
        "x-pi-cloud-upload": Buffer.from(JSON.stringify(input.metadata)).toString("base64url"),
      },
      body,
      duplex: "half",
      signal,
    });
    return await input.read(response);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Receipts contain metadata only, independent of the file's size. */
export async function readUploadReceipt(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Upload receipt is empty");
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 64 * 1024) throw new Error("Upload receipt exceeds its metadata envelope");
      chunks.push(Buffer.from(item.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
