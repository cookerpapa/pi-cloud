import { request as httpRequest } from "node:http";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { PREVIEW_SCOPE_HEADER, TOOL_BROKER_SANDBOX_PREVIEW_PATH } from "@pi-cloud/protocol";
import { ToolBrokerServer, type ToolBrokerBackend } from "../src/tool-broker-server.ts";

const token = "preview-test-" + "s".repeat(40);
const baseScope = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  workspaceId: "10000000-0000-4000-8000-000000000003",
  target: { kind: "conversation", sessionId: "10000000-0000-4000-8000-000000000004" },
  port: 4173,
};
describe("Tool Broker application CONNECT", () => {
  it("checks service authority and expiry before opening a byte stream, then closes it at expiry", async () => {
    const stream = new PassThrough();
    const open = vi.fn(async () => stream);
    const backend = {
      checkHealth: async () => {},
      close: async () => {},
      openPreviewConnection: open,
      providerId: "test",
      activeCount: 0,
      admittedCount: 0,
      admissionWaitingCount: 0,
      maximumActiveSandboxes: 10,
      cleanPrewarmCount: 0,
    } as unknown as ToolBrokerBackend;
    const server = new ToolBrokerServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken: token,
      terminalToken: token,
      broker: backend,
    });
    const address = await server.listen();
    const connect = (authorization: string, expiresAt: number) =>
      new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
        const request = httpRequest(new URL(TOOL_BROKER_SANDBOX_PREVIEW_PATH, address), {
          method: "CONNECT",
          headers: {
            authorization,
            [PREVIEW_SCOPE_HEADER]: Buffer.from(
              JSON.stringify({ ...baseScope, expiresAt }),
            ).toString("base64url"),
          },
        });
        request.once("error", reject);
        request.once("connect", (response, socket) =>
          resolve({ status: response.statusCode!, socket }),
        );
        request.end();
      });
    try {
      const denied = await connect("Bearer wrong", Date.now() + 1000);
      expect(denied.status).toBe(401);
      denied.socket.destroy();
      expect(open).not.toHaveBeenCalled();
      const expired = await connect(`Bearer ${token}`, Date.now() - 1);
      expect(expired.status).not.toBe(200);
      expired.socket.destroy();
      expect(open).not.toHaveBeenCalled();
      const allowed = await connect(`Bearer ${token}`, Date.now() + 150);
      expect(allowed.status).toBe(200);
      const data = new Promise<Buffer>((resolve) => allowed.socket.once("data", resolve));
      allowed.socket.write(Buffer.from([0, 255, 65]));
      expect(await data).toEqual(Buffer.from([0, 255, 65]));
      await new Promise<void>((resolve) => allowed.socket.once("close", () => resolve()));
      expect(stream.destroyed).toBe(true);
    } finally {
      await server.close();
    }
  });
});
