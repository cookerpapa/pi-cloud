import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { BoxLiteRuntimeClient } from "../src/boxlite-runtime-client.ts";
import type { BoxLiteInstance } from "../src/boxlite-node-contract.ts";

async function fixture() {
  const seen: { method: string; path: string; body: Buffer }[] = [];
  const instance: BoxLiteInstance = {
    sandboxId: "box-fixture",
    nodeId: "owned-node",
    templateId: "tool",
    state: "running",
    metadata: { "picloud.workspace_runtime_id": randomUUID() },
    cpuCount: 1,
    memoryMB: 1024,
    attachment: {
      volumeId: "pcw-" + "a".repeat(48),
      namespace: "boxlite-owned-node",
      sandboxId: "allocation",
      hostPath: "/owned/workspace",
      metadata: {},
    },
    connection: { hostBootId: randomUUID(), processes: [{ pid: 10, startTime: "40" }] },
  };
  let loseCreate = false,
    oversized = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: request.method!, path: request.url!, body });
      if (request.headers.authorization !== "Bearer " + "fixture-".repeat(8)) {
        response.writeHead(401);
        response.end("{}");
        return;
      }
      if (request.url === "/internal/v1/boxlite/boxes" && request.method === "POST" && loseCreate) {
        response.destroy();
        return;
      }
      const value =
        request.url === "/health/ready"
          ? { status: "ready", nodeId: "owned-node", sdkVersion: "0.12.0", protocolVersion: 2 }
          : request.url === "/internal/v1/boxlite/boxes"
            ? instance
            : request.url?.endsWith("/command")
              ? { stdout: oversized ? "X".repeat(20) : "ok", stderr: "", exitCode: 0 }
              : request.url?.endsWith("/observe")
                ? {
                    runtimeName: instance.sandboxId,
                    nodeId: instance.nodeId,
                    presence: "unavailable",
                    state: "unknown",
                  }
                : { confirmed: true };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new BoxLiteRuntimeClient({
    url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
    token: "fixture-".repeat(8),
    nodeId: "owned-node",
  });
  return {
    client,
    instance,
    seen,
    loseCreate() {
      loseCreate = true;
    },
    oversized() {
      oversized = true;
    },
    async close() {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("does not replay an uncertain native creation or substitute another provider", async () => {
  const f = await fixture();
  try {
    await f.client.checkHealth();
    f.loseCreate();
    await expect(f.client.create({ templateId: "tool", metadata: {} })).rejects.toThrow(
      "transport",
    );
    expect(f.seen.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(f.seen.every((r) => !r.path.includes("volumes"))).toBe(true);
  } finally {
    await f.close();
  }
});
it("uses only BoxLite endpoints and retains the original deletion evidence", async () => {
  const f = await fixture();
  try {
    await f.client.destroy(f.instance.sandboxId, f.instance);
    expect(JSON.parse(f.seen[0]!.body.toString())).toEqual(f.instance);
    expect(f.seen[0]!.path).toBe("/internal/v1/boxlite/delete");
    expect(f.seen.every((r) => !r.path.includes("volumes"))).toBe(true);
    expect(
      (await f.client.observe(f.instance.sandboxId, f.instance.nodeId, f.instance)).presence,
    ).toBe("unavailable");
  } finally {
    await f.close();
  }
});
it("streams exact staging bytes and refuses over-bound control replies", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from([0, 255, 128, 1, 13, 10]);
    await f.client.writeGuestFile(f.instance, "/tmp/pi-cloud-owned", bytes);
    expect(f.seen[0]!.body).toEqual(bytes);
    f.oversized();
    await expect(
      f.client.runCommand(f.instance, {
        command: "owned-helper",
        cwd: "/",
        user: "root",
        timeoutMs: 1000,
        maximumOutputBytes: 10,
      }),
    ).rejects.toThrow("contract");
  } finally {
    await f.close();
  }
});
