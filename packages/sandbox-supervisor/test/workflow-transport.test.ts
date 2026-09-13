import { expect, it } from "vitest";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { readWorkflowResult } from "../src/workflow-transport.ts";

it("streams many sequential workflow calls without retaining completed replies", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing test listener");
  const activationId = crypto.randomUUID(),
    operationId = crypto.randomUUID();
  const resultUrl = new URL(`http://127.0.0.1:${address.port}/result`);
  let count = 0;
  server.on("connection", (socket) => {
    const next = () =>
      socket.send(
        JSON.stringify({ type: "call", id: ++count, method: "status", args: { target: "child" } }),
      );
    socket.on("message", (bytes) => {
      const frame = JSON.parse(bytes.toString());
      expect(frame).toMatchObject({ id: count, ok: true, value: { state: "running" } });
      if (count < 512) next();
      else
        socket.send(
          JSON.stringify({
            type: "result",
            response: {
              toolBrokerProtocolVersion: 1,
              type: "tool_sandbox.operation_result",
              activationId,
              operationId,
              operation: "workflow.exec",
              ok: true,
              value: "complete",
            },
          }),
        );
    });
    next();
  });
  try {
    await expect(
      readWorkflowResult({
        resultUrl,
        executionLease: "test",
        activationId,
        operationId,
        signal: AbortSignal.timeout(5000),
        call: async () => ({ state: "running" }),
      }),
    ).resolves.toMatchObject({ ok: true, value: "complete" });
    expect(count).toBe(512);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
