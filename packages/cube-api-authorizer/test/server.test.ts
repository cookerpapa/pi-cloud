import { execFile } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createCubeApiAuthorizerServer } from "../src/server.ts";

it("survives a client disconnect in the middle of a verification body", async () => {
  // Run the real listener in its own process: an unhandled async HTTP rejection
  // must fail this check rather than being hidden by a test-runner error hook.
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      import assert from 'node:assert/strict';
      import { connect } from 'node:net';
      import { once } from 'node:events';
      import { createCubeApiAuthorizerServer } from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
      const server=createCubeApiAuthorizerServer('a'.repeat(64));
      const body=Promise.withResolvers();
      server.on('request', request => request.once('data',()=>body.resolve()));
      server.listen(0,'127.0.0.1'); await once(server,'listening');
      const port=server.address().port;
      const socket=connect(port,'127.0.0.1');
      socket.on('error',()=>{});
      try {
        await once(socket,'connect');
        socket.write('POST /verify HTTP/1.1\\r\\nHost: localhost\\r\\nContent-Length: 1000\\r\\n\\r\\n{');
        await body.promise;
        const closed=once(socket,'close'); socket.destroy(); await closed;
        await new Promise(resolve=>setImmediate(resolve));
        const health=await fetch('http://127.0.0.1:'+port+'/health');
        assert.equal(health.status,200); await health.arrayBuffer();
        console.log('AUTHORIZE_STILL_ALIVE');
      } finally { socket.destroy(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
    `,
    ],
    { timeout: 10_000, env: { ...process.env, NODE_USE_ENV_PROXY: "0" } },
  );
  expect(result.stdout).toContain("AUTHORIZE_STILL_ALIVE");
});

it("returns an explicit body limit without destroying the socket before the reply", async () => {
  const server = createCubeApiAuthorizerServer("a".repeat(64));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener");
    const response = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const client = request(
          `http://127.0.0.1:${address.port}/verify`,
          {
            method: "POST",
            headers: { "content-length": "1000000" },
          },
          (reply) => {
            let body = "";
            reply.on("data", (chunk: Buffer) => {
              body += chunk.toString();
            });
            reply.once("error", reject);
            reply.once("end", () => {
              client.destroy();
              resolve({ status: reply.statusCode, body });
            });
          },
        );
        client.once("error", reject);
        client.setTimeout(2000, () => client.destroy(new Error("Missing rejection response")));
        client.write("x".repeat(8192));
      },
    );
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ error: "body_too_large" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
