import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { S3ImageBlobStore } from "../src/s3.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const store = new S3ImageBlobStore({
    endpoint: `http://127.0.0.1:${address.port}`,
    region: "us-east-1",
    bucket: "review",
    accessKeyId: "test",
    secretAccessKey: "test",
    idleTimeoutMs: 250,
    connectionTimeoutMs: 1000,
  });
  cleanup.push(async () => {
    store.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return store;
}

it("terminates a streamed PUT whose complete body is accepted without a receipt", async () => {
  let received = 0;
  const store = await fixture((request) => {
    request.on("data", (chunk: Buffer) => (received += chunk.length));
  });
  const upload = store.putStream(
    "image",
    (async function* () {
      yield Buffer.alloc(1024);
    })(),
    1024,
    "image/png",
    new AbortController().signal,
  );
  await expect(upload).rejects.toMatchObject({ name: "TimeoutError" });
  expect(received).toBe(1024);
});

it("does not start a second buffered PUT after losing the first response", async () => {
  let requests = 0;
  const store = await fixture((request) => {
    requests++;
    request.resume();
  });
  await expect(
    store.put("one-writer", Buffer.alloc(1024), "image/png", AbortSignal.timeout(3000)),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  expect(requests).toBe(1);
});

it("owns a failing request-body stream and cancels its HTTP request", async () => {
  const store = await fixture((request) => request.resume());
  const sourceError = new Error("Owned source failed");
  await expect(
    store.putStream(
      "failed-source",
      (async function* () {
        yield Buffer.alloc(512);
        throw sourceError;
      })(),
      1024,
      "image/png",
      AbortSignal.timeout(3000),
    ),
  ).rejects.toBeInstanceOf(Error);
});

it("allows a progressing PUT longer than the socket idle deadline", async () => {
  let received = 0;
  const store = await fixture((request, response) => {
    request.on("data", (chunk: Buffer) => (received += chunk.length));
    request.on("end", () => response.writeHead(200).end());
  });
  await store.putStream(
    "image",
    (async function* () {
      for (let i = 0; i < 8; i++) {
        yield Buffer.alloc(1024);
        await delay(75);
      }
    })(),
    8192,
    "image/png",
    new AbortController().signal,
  );
  expect(received).toBe(8192);
});

it("cancels a receipt wait through the caller signal without retrying the stream", async () => {
  const consumed = Promise.withResolvers<void>();
  let requests = 0;
  const store = await fixture((request) => {
    requests++;
    request.resume();
    request.on("end", consumed.resolve);
  });
  const controller = new AbortController();
  const upload = store.putStream(
    "image",
    (async function* () {
      yield Buffer.alloc(1024);
    })(),
    1024,
    "image/png",
    controller.signal,
  );
  const failed = expect(upload).rejects.toMatchObject({ name: "AbortError" });
  await consumed.promise;
  controller.abort();
  await failed;
  expect(requests).toBe(1);
});

it("cancels a GET after headers while the response body is stalled", async () => {
  const store = await fixture((_request, response) => {
    response.writeHead(200, { "content-length": "2048" });
    response.write(Buffer.alloc(1024));
  });
  const controller = new AbortController();
  const iterator = store.readStream("image", 2048, controller.signal);
  expect((await iterator.next()).value?.byteLength).toBe(1024);
  const pending = iterator.next();
  const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await failed;
});
