import { expect, it } from "vitest";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { readWorkflowResult } from "../src/workflow-transport.ts";
import type { NativeToolEnd } from "@pi-cloud/protocol";
import { ToolExecutionFailure } from "@pi-cloud/protocol";

it.each(["completed", "business-error", "not-started"] as const)(
  "preserves a known %s reply when Workflow observation begins after Stop",
  async (kind) => {
    const stopped = new AbortController();
    stopped.abort();
    const failure = new ToolExecutionFailure({
      code: "tool_cancelled_before_start",
      effect: "not_started",
      message: "Did not start",
    });
    const completion =
      kind === "not-started"
        ? Promise.reject(failure)
        : Promise.resolve<NativeToolEnd>({
            type: "tool_execution_end",
            toolCallId: "call",
            toolName: "bash",
            isError: kind === "business-error",
            result: { content: [{ type: "text", text: "business failure" }], details: 42 },
          });
    const result = readWorkflowResult({
      resultUrl: new URL("http://127.0.0.1:1/result"),
      executionReference: "test",
      activationId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      call: async () => null,
      completion,
      signal: stopped.signal,
    });
    if (kind === "not-started") await expect(result).rejects.toBe(failure);
    else
      await expect(result).resolves.toMatchObject({
        operation: "workflow.exec",
        ok: kind === "completed",
        ...(kind === "completed"
          ? {
              value: {
                content: [{ type: "text", text: "business failure" }],
                details: 42,
                isError: false,
              },
            }
          : { error: "business failure" }),
      });
  },
);

it("streams many sequential workflow calls without retaining completed replies", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing test listener");
  const activationId = crypto.randomUUID(),
    operationId = crypto.randomUUID();
  const resultUrl = new URL(`http://127.0.0.1:${address.port}/result`);
  let count = 0;
  let completed!: (event: NativeToolEnd) => void;
  const completion = new Promise<NativeToolEnd>((resolve) => {
    completed = resolve;
  });
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
        completed({
          type: "tool_execution_end",
          toolCallId: "workflow",
          toolName: "bash",
          result: { content: [], details: "complete" },
          isError: false,
        });
    });
    next();
  });
  try {
    await expect(
      readWorkflowResult({
        resultUrl,
        executionReference: "test",
        activationId,
        operationId,
        signal: AbortSignal.timeout(5000),
        call: async () => ({ state: "running" }),
        completion,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { content: [], details: "complete", isError: false },
    });
    expect(count).toBe(512);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
