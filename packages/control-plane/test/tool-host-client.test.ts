import Fastify from "fastify";
import { expect, it } from "vitest";
import { ToolHostClient, TOOL_HOST_EXECUTE_PATH } from "../src/tool-host-client.ts";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
import type { ToolCatalogPublication } from "@pi-cloud/protocol";

it.each(["success", "refused", "lost_reply"] as const)(
  "fixes one implementation identity and never resends an uncertain RPC (%s)",
  async (mode) => {
    const app = Fastify();
    let calls = 0;
    const command = {
      operationId: "operation",
      implementation: { releaseId: "release-2", generation: 2, replay: "never" },
      nativeCallId: "call",
      toolName: "preview",
    } as AcceptedControlToolCommand;
    app.post(TOOL_HOST_EXECUTE_PATH, async (request, reply) => {
      calls++;
      expect(request.body).toEqual({ releaseId: "release-2", command });
      if (mode === "refused") return reply.code(503).send({ error: "draining" });
      if (mode === "lost_reply") {
        reply.raw.destroy();
        return reply;
      }
      return {
        operationId: command.operationId,
        releaseId: "release-2",
        result: {
          toolCallId: "call",
          toolName: "preview",
          isError: false,
          result: { content: [{ type: "text", text: "ready" }] },
        },
      };
    });
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new ToolHostClient({
      baseUrl,
      token: "test-only-token",
      catalog: () => ({ releaseId: "release-2", generation: 2 }) as ToolCatalogPublication,
    });
    try {
      const result = await client.execute(command, () => true);
      if (mode === "success")
        expect(result).toHaveProperty("packed.result.content.0.text", "ready");
      else
        expect(JSON.stringify(result)).toContain(
          mode === "refused" ? "tool_unavailable" : "tool_result_unknown",
        );
      expect(calls).toBe(1);
    } finally {
      await client.close();
      await app.close();
    }
  },
);
