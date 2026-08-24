import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "x-untrusted-header": "must-not-cross-boundary",
    });
    response.end(`preview:${request.url ?? ""}`);
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolvePromise, rejectPromise) =>
    server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
  );
});

async function run(request: unknown): Promise<Readonly<Record<string, unknown>>> {
  const path = `/tmp/pi-cloud-envd-${randomUUID()}.json`;
  try {
    await writeFile(path, JSON.stringify({ mode: "preview_http", request }), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      const result = await execute(
        process.execPath,
        ["--import", "tsx", "src/envd-preview-proxy.ts", path],
        { cwd: new URL("..", import.meta.url), maxBuffer: 24 * 1_024 * 1_024, timeout: 10_000 },
      );
      return JSON.parse(result.stdout) as Readonly<Record<string, unknown>>;
    } catch (error: unknown) {
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error
          ? String(error.stderr)
          : "";
      throw new Error(stderr || "Preview helper failed", { cause: error });
    }
  } finally {
    await rm(path, { force: true });
  }
}

describe("one-shot envd preview proxy", () => {
  it("proxies an arbitrary localhost application port with bounded response headers", async () => {
    const response = await run({
      port,
      method: "GET",
      path: "/snake?level=2",
      headers: { accept: "text/plain" },
      maximumResponseBytes: 64 * 1_024,
      timeoutMs: 5_000,
    });
    expect(response).toMatchObject({
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: Buffer.from("preview:/snake?level=2").toString("base64"),
    });
    expect(response.headers).not.toHaveProperty("x-untrusted-header");
  });

  it("refuses to proxy the trusted envd control port", async () => {
    await expect(
      run({
        port: 49_983,
        method: "GET",
        path: "/health",
        headers: {},
        maximumResponseBytes: 1_024,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("Preview port was invalid");
  });
});
