import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { previewConnectionAgent } from "../src/preview-connect.ts";

it("connects directly to the trusted preview owner despite a global egress proxy", async () => {
  const owner = http.createServer();
  const scopes: unknown[] = [];
  owner.on("connect", (request, socket) => {
    socket.on("error", () => {});
    scopes.push({ path: request.url, authorization: request.headers.authorization });
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"));
  });
  owner.listen(0, "127.0.0.1");
  await once(owner, "listening");
  const proxy = vi.spyOn(http.globalAgent, "createConnection").mockImplementation(() => {
    throw new Error("Private owner traffic reached the egress proxy");
  });
  const agent = previewConnectionAgent(
    `http://127.0.0.1:${(owner.address() as AddressInfo).port}`,
    "preview-test-token",
    {
      tenantId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      workspaceId: "00000000-0000-4000-8000-000000000003",
      target: {
        kind: "development_environment",
        environmentId: "00000000-0000-4000-8000-000000000004",
      },
      port: 5173,
      expiresAt: Date.now() + 60_000,
    },
    true,
  );
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const request = http.get("http://localhost:5173/", { agent }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString()));
        response.on("error", reject);
      });
      request.on("error", reject);
    });
    expect(result).toBe("ok");
    expect(proxy).not.toHaveBeenCalled();
    expect(scopes).toEqual([
      { path: "/internal/v1/sandbox-preview", authorization: "Bearer preview-test-token" },
    ]);
  } finally {
    proxy.mockRestore();
    agent.destroy();
    await new Promise<void>((resolve) => owner.close(() => resolve()));
  }
});
