import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";

declare module "fastify" {
  interface FastifyContextConfig {
    piCloudStreamUpload?: boolean;
  }
}

/** Upload routes retain a byte stream. Internal native publication routes keep
 * their bounded binary JSON envelope, including opaque Tool argument keys. */
export function installBinaryBodyParser(server: FastifyInstance): void {
  server.addContentTypeParser(
    "application/octet-stream",
    async (request: FastifyRequest, body: Readable) => {
      if (request.routeOptions.config.piCloudStreamUpload === true) return body;
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of body) {
        length += chunk.byteLength;
        if (length > request.routeOptions.bodyLimit)
          throw Object.assign(new Error("Binary message exceeds its transport envelope"), {
            statusCode: 413,
            code: "FST_ERR_CTP_BODY_TOO_LARGE",
          });
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, length);
    },
  );
}
