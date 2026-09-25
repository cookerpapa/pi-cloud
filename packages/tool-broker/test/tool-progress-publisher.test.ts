import { it, expect, vi } from "vitest";
import { createServer } from "node:http";
import { ToolProgressPublisher } from "../src/tool-progress-publisher.ts";
import type { ToolProgressDelivery } from "@pi-cloud/protocol";

it("reuses HTTP, drops failures, redirects the next snapshot and forgets completed operations", async () => {
  const delivered: ToolProgressDelivery[] = [];
  let mode = "ok",
    connections = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    delivered.push(JSON.parse(body));
    if (mode === "failed") {
      response.writeHead(503).end();
      return;
    }
    if (mode === "redirect") {
      response.writeHead(307, { location: `${url}/internal/v1/tool-progress` }).end();
      return;
    }
    response.writeHead(204).end();
  });
  server.on("connection", () => connections++);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sender = new ToolProgressPublisher(url, "private-token");
  const payload: ToolProgressDelivery = {
    tenantId: "t",
    partition: 0,
    progress: {
      type: "tool.progress",
      sessionId: "s",
      turnId: "turn",
      toolCallId: "tool",
      operationId: "op",
      revision: 1,
      text: "first",
    },
  };
  try {
    for (let i = 1; i <= 1000; i++)
      sender.update({ ...payload, progress: { ...payload.progress, revision: i } });
    sender.flush();
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0]!.progress.revision).toBe(1000);
    mode = "failed";
    sender.update({ ...payload, progress: { ...payload.progress, revision: 1001 } });
    sender.flush();
    await vi.waitFor(() => expect(delivered).toHaveLength(2), { timeout: 2000 });
    mode = "redirect";
    sender.update({ ...payload, progress: { ...payload.progress, revision: 1002 } });
    await vi.waitFor(() => expect(delivered).toHaveLength(3), { timeout: 2000 });
    mode = "ok";
    sender.update({ ...payload, progress: { ...payload.progress, revision: 1003 } });
    await vi.waitFor(() => expect(delivered).toHaveLength(4), { timeout: 2000 });
    expect(connections).toBe(1);
    sender.update(payload);
    sender.forget("op");
    sender.flush();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(delivered).toHaveLength(4);
  } finally {
    await sender.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
