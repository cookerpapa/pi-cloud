import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { TOOL_PROGRESS_PATH } from "@pi-cloud/protocol";
import { ToolProgressIngress } from "../src/tool-progress-ingress.ts";

describe("temporary Tool progress ingress", () => {
  it("authenticates, routes partition ownership without PG and tolerates owner loss", async () => {
    const server = Fastify();
    const owner = vi.fn(async (_partition: number): Promise<string | undefined> => undefined),
      publish = vi.fn();
    new ToolProgressIngress("private-service-token", owner, publish).install(server);
    const payload = {
      tenantId: "t",
      partition: 2,
      progress: {
        type: "tool.progress",
        sessionId: "s",
        turnId: "turn",
        operationId: "op",
        toolCallId: "tool",
        revision: 1,
        text: "hello",
      },
    };
    const request = {
      method: "POST" as const,
      url: TOOL_PROGRESS_PATH,
      payload,
      headers: { authorization: "Bearer private-service-token" },
    };
    try {
      expect((await server.inject({ ...request, headers: {} })).statusCode).toBe(401);
      expect(owner).not.toHaveBeenCalled();
      expect((await server.inject(request)).statusCode).toBe(204);
      expect(publish).toHaveBeenCalledExactlyOnceWith(payload);
      owner.mockResolvedValueOnce("http://other:3000");
      const redirect = await server.inject(request);
      expect(redirect.statusCode).toBe(307);
      expect(redirect.headers.location).toBe(`http://other:3000${TOOL_PROGRESS_PATH}`);
      owner.mockRejectedValueOnce(new Error("rebalancing"));
      expect((await server.inject(request)).statusCode).toBe(503);
      expect(publish).toHaveBeenCalledOnce();
      expect(
        (
          await server.inject({
            ...request,
            payload: { ...payload, progress: { ...payload.progress, text: "x".repeat(8193) } },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await server.close();
    }
  });
});
