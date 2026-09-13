import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { HttpSupervisorManagementClient } from "../src/http-supervisor-management.ts";

it("routes internal Worker management independently from the model/global fetch proxy", async () => {
  const paths: string[] = [],
    server = createServer((request, response) => {
      paths.push(request.url!);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ accepted: true, result: { delivered: true } }));
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  const proxyFetch = vi.fn(async () => {
    throw new Error("model egress must not receive management traffic");
  });
  vi.stubGlobal("fetch", proxyFetch);
  try {
    const client = new HttpSupervisorManagementClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      managementToken: "x".repeat(48),
      allowInsecureHttp: true,
    });
    await expect(
      client.subagent({ action: "schedule", runId: crypto.randomUUID() }),
    ).resolves.toEqual({ delivered: true });
    expect(paths).toEqual(["/internal/v1/subagent-runtime"]);
    expect(proxyFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
