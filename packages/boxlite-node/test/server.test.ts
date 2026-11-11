import { Duplex } from "node:stream";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { BoxLiteRuntimeClient } from "@pi-cloud/sandbox-control/boxlite-client";
import type { BoxLiteInstance } from "@pi-cloud/sandbox-control/boxlite-node-contract";
import { createBoxLiteNodeServer } from "../src/server.ts";
import type { BoxLiteNodeBackend } from "../src/backend.ts";

it("authenticates mechanical commands and carries binary application bytes without UTF-8 conversion", async () => {
  const command = vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0 }));
  const close = vi.fn(async () => {});
  const backend = {
    options: { nodeId: "owned" },
    ready: async () => {},
    close,
    command,
    tcp: async () =>
      Duplex.from(async function* (source) {
        for await (const chunk of source) yield chunk;
      }),
  } as unknown as BoxLiteNodeBackend;
  const server = createBoxLiteNodeServer(backend, "owned-".repeat(8));
  const url = await server.listen({ host: "127.0.0.1", port: 0 });
  const client = new BoxLiteRuntimeClient({
    url,
    token: "owned-".repeat(8),
    nodeId: "owned",
    volumes: {
      async ensureVolume() {
        throw new Error("unused");
      },
      async deleteVolume() {
        throw new Error("unused");
      },
      async close() {},
    },
  });
  try {
    const denied = await server.inject({
      method: "POST",
      url: "/internal/v1/boxlite/boxes/box/command",
      payload: {},
    });
    expect(denied.statusCode).toBe(401);
    expect(command).not.toHaveBeenCalled();
    await client.checkHealth();
    const instance = { sandboxId: "box" } as BoxLiteInstance;
    expect(
      await client.runCommand(instance, {
        command: "owned",
        cwd: "/",
        user: "root",
        timeoutMs: 1000,
        maximumOutputBytes: 10,
      }),
    ).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
    const stream = await client.openTcp(instance, 8080);
    const received = once(stream, "data"),
      bytes = Buffer.from([0, 128, 255, 10, 13, 0, 250]);
    stream.write(bytes);
    expect(Buffer.from((await received)[0])).toEqual(bytes);
    stream.destroy();
  } finally {
    await client.close();
    await server.close();
  }
  expect(close).toHaveBeenCalledOnce();
}, 10000);
