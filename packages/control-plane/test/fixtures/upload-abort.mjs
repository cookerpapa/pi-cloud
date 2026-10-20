import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { forkUpload, verifiedUpload } from "../../src/workspace-upload-stream.ts";
import { uploadHttp } from "../../../sandbox-control/src/upload-http.ts";
import { S3ImageBlobStore } from "../../../session-attachments/src/s3.ts";

const waiting = [Promise.withResolvers(), Promise.withResolvers()];
const servers = waiting.map((signal) =>
  createServer((request) => {
    request.on("error", () => {});
    request.once("data", () => signal.resolve());
    request.resume();
  }),
);
for (const server of servers) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}
const endpoint = (index) => `http://127.0.0.1:${servers[index].address().port}`;
const store = new S3ImageBlobStore({
  endpoint: endpoint(1),
  region: "us-east-1",
  bucket: "fixture",
  accessKeyId: "test",
  secretAccessKey: "test",
  idleTimeoutMs: 10000,
});
const abort = new AbortController();
const data = Buffer.alloc(1024 * 1024, 65);
const ingress = new PassThrough({ highWaterMark: 65536 });
ingress.on("error", () => {});
const content = {
  byteLength: data.length,
  sha256: createHash("sha256").update(data).digest("hex"),
  chunks: (async function* () {
    yield data.subarray(0, 65536);
    if (!abort.signal.aborted)
      await new Promise((resolve) =>
        abort.signal.addEventListener("abort", resolve, { once: true }),
      );
    abort.signal.throwIfAborted();
  })(),
};
if (process.argv[2] === "source_error") content.chunks = ingress;
const fork = forkUpload(verifiedUpload(content, abort.signal), abort.signal);
try {
  const effects = [
    uploadHttp({
      url: endpoint(0),
      token: "owned-fixture",
      metadata: content,
      chunks: fork.workspace,
      signal: abort.signal,
      receiptTimeoutMs: 10000,
      read: async () => {
        throw new Error("Partial upload must not produce a receipt");
      },
    }),
    store.putStream(
      "partial",
      (async function* () {
        for await (const chunk of fork.image) {
          abort.signal.throwIfAborted();
          yield chunk;
        }
      })(),
      data.length,
      "image/png",
      abort.signal,
    ),
  ];
  const settled = Promise.allSettled(
    effects.map((p) =>
      p.catch((e) => {
        abort.abort(e);
        throw e;
      }),
    ),
  );
  if (process.argv[2] === "source_error") ingress.write(data.subarray(0, 65536));
  if (process.argv[2] === "early") await Promise.resolve();
  else if (process.argv[2] === "workspace") await waiting[0].promise;
  else await Promise.all(waiting.map((p) => p.promise));
  if (process.argv[2] === "source_error") ingress.destroy(new Error("Owned upload input reset"));
  else abort.abort(new Error("Owned upload caller disconnected"));
  const outcomes = await settled;
  assert(outcomes.every((o) => o.status === "rejected"));
  await new Promise((resolve) => setImmediate(resolve));
  console.log("owned_upload_abort_settled");
} finally {
  abort.abort();
  ingress.destroy();
  fork.close();
  store.close();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
