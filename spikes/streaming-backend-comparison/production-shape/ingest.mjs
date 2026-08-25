import { createServer } from "node:http";
import {
  INGEST_TOKEN,
  connectJetStream,
  createPool,
  decode,
  encode,
  sessionSubject,
} from "./common.mjs";

const pool = createPool(32);
const runtime = await connectJetStream("pi-cloud-production-shape-ingest");
let accepted = 0;
let rejected = 0;

async function body(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return decode(Buffer.concat(chunks));
}

async function publish(value) {
  const authority = await pool.query(
    `select 1 from spike_sessions
     where session_id = $1 and attempt_id = $2 and fence = $3 and state = 'active'`,
    [value.sessionId, value.attemptId, value.fence],
  );
  if (authority.rowCount !== 1) {
    rejected += 1;
    return { status: 409, value: { error: "stale_attempt_authority" } };
  }
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const acknowledgement = await runtime.jetstream.publish(
        sessionSubject(value.sessionId),
        encode(value),
        { msgID: value.eventId, timeout: 2_000 },
      );
      accepted += 1;
      return {
        status: 202,
        value: {
          streamSequence: acknowledgement.seq,
          duplicate: acknowledgement.duplicate,
        },
      };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, 25 * 2 ** attempt)));
    }
  }
  throw lastError;
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ready", accepted, rejected }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/events") {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${INGEST_TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    const result = await publish(await body(request));
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(JSON.stringify(result.value));
  } catch {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "ingest_unavailable" }));
  }
});

server.listen(18092, "127.0.0.1", () => process.send?.({ type: "ready" }));

async function close() {
  await new Promise((resolve) => server.close(resolve));
  await runtime.connection.close();
  await pool.end();
}

process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
