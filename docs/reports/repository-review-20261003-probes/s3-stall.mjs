// Review reproducer for baseline 4294c759. No production resources are touched.
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { S3ImageBlobStore } from "../../../packages/session-attachments/src/s3.ts";
const record = {
  scenario: "S3 accepts complete streamed PUT then withholds HTTP response",
  startedAt: new Date().toISOString(),
};
let endBody;
const consumed = new Promise((r) => (endBody = r));
const sockets = new Set();
const server = createServer(async (req, res) => {
  let bytes = 0;
  for await (const c of req) bytes += c.length;
  record.serverConsumedBytes = bytes;
  endBody();
});
server.on("connection", (s) => {
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const store = new S3ImageBlobStore({
  endpoint: `http://127.0.0.1:${server.address().port}`,
  region: "us-east-1",
  bucket: "review",
  accessKeyId: "test",
  secretAccessKey: "test",
});
const abort = new AbortController();
let settled = false;
const start = performance.now();
const pending = store
  .putStream(
    "review",
    (async function* () {
      yield Buffer.alloc(1024);
    })(),
    1024,
    "image/png",
    abort.signal,
  )
  .then(
    () => {
      settled = true;
      record.outcome = "resolved";
    },
    (e) => {
      settled = true;
      record.outcome = e.name;
    },
  );
await consumed;
await new Promise((r) => setTimeout(r, 65000));
record.pendingAfter65Seconds = !settled;
record.elapsedMs = Math.round(performance.now() - start);
abort.abort();
await pending;
record.cancelSettled = settled;
store.close();
for (const s of sockets) s.destroy();
await new Promise((r) => server.close(r));
await writeFile(
  "/tmp/pi-cloud-review-s3-stall-result.json",
  JSON.stringify(record, null, 2) + "\n",
);
console.log(JSON.stringify(record));
