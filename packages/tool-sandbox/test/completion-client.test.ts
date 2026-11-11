import { createServer } from "node:https";
import { randomUUID, createHash } from "node:crypto";
import { expect, it } from "vitest";
import { GuestCompletionClient } from "@pi-cloud/workspace-runtime/tool-completion-client";
import { testTls } from "../../cube-completion/test/tls-fixture.ts";

it("retries the identical finalized result after a lost HTTP ACK without executing another command", async () => {
  const tls = await testTls(),
    bodies: string[] = [];
  const server = createServer(tls, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    bodies.push(body);
    expect(request.headers.authorization).toBe("Bearer operation-only");
    if (bodies.length === 1) response.destroy();
    else {
      response.writeHead(204);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port,
      operationId = randomUUID();
    const client = new GuestCompletionClient(
      {
        url: `https://localhost:${port}/v1/completions`,
        address: "127.0.0.1",
        ca: tls.cert,
        capability: "operation-only",
        expiresAt: Date.now() + 5000,
      },
      operationId,
    );
    const result = {
      toolWorkerProtocolVersion: 7,
      type: "worker.operation_result",
      response: { operationId, text: "one completed effect" },
    };
    await client.complete(result);
    expect(bodies).toHaveLength(2);
    expect(
      new Set(bodies.map((body) => createHash("sha256").update(body).digest("hex"))).size,
    ).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ kind: "result", operationId, output: result });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
