import Fastify from "fastify";
import { expect, it } from "vitest";
import { Readable } from "node:stream";
import { installBinaryBodyParser } from "../src/binary-body-parser.ts";

it("streams only upload routes while preserving bounded internal binary publications", async () => {
  const server = Fastify();
  installBinaryBodyParser(server);
  server.post("/publication", { bodyLimit: 128 }, async (request) => {
    expect(Buffer.isBuffer(request.body)).toBe(true);
    const value = JSON.parse((request.body as Buffer).toString());
    expect(Object.hasOwn(value.arguments, "__proto__")).toBe(true);
    return { accepted: true };
  });
  server.put("/upload", { config: { piCloudStreamUpload: true } }, async (request) => {
    expect(request.body).toBeInstanceOf(Readable);
    let bytes = 0;
    for await (const chunk of request.body as Readable) bytes += chunk.length;
    return { bytes };
  });
  const headers = { "content-type": "application/octet-stream" };
  try {
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/publication",
          headers,
          payload: Buffer.from('{"arguments":{"__proto__":"opaque"}}'),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/publication",
          headers,
          payload: Buffer.alloc(129),
        })
      ).statusCode,
    ).toBe(413);
    const upload = await server.inject({
      method: "PUT",
      url: "/upload",
      headers,
      payload: Buffer.alloc(17 * 1024 * 1024),
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.json()).toEqual({ bytes: 17 * 1024 * 1024 });
  } finally {
    await server.close();
  }
});
