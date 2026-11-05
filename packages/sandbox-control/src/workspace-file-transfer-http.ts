import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  WORKSPACE_FILE_TRANSFER_PATH,
  parseWorkspaceFileTransferRequest,
  parseWorkspaceFileTransferSnapshot,
  type WorkspaceFileTransferRequest,
  type WorkspaceFileTransferSnapshot,
} from "@pi-cloud/protocol";
import { WorkspaceFileTransferError } from "@pi-cloud/workspace-runtime";
import { uploadHttp, readUploadReceipt } from "./upload-http.ts";

export function installWorkspaceFileTransferRoute(
  server: FastifyInstance,
  options: {
    authorized(value: string | undefined): boolean;
    preflight?(request: WorkspaceFileTransferRequest): Promise<void>;
    execute(
      request: WorkspaceFileTransferRequest,
      chunks?: AsyncIterable<Uint8Array>,
      signal?: AbortSignal,
    ): Promise<WorkspaceFileTransferSnapshot>;
    failure(reply: FastifyReply, error: unknown): unknown;
    signal?: AbortSignal;
  },
) {
  const parse = (value: unknown) => {
    if (typeof value !== "string" || value.length > 24_000)
      throw new Error("Invalid file transfer envelope");
    return parseWorkspaceFileTransferRequest(
      JSON.parse(Buffer.from(value, "base64url").toString()),
    );
  };
  const failure = (reply: FastifyReply, error: unknown) => {
    if (error instanceof WorkspaceFileTransferError)
      return reply
        .code(
          error.code === "transfer_missing"
            ? 404
            : error.code === "transfer_expired"
              ? 410
              : error.code === "transfer_busy" || error.retryable
                ? 503
                : 409,
        )
        .send({
          error: {
            code: error.code,
            message: error.message,
            retryable: error.code === "transfer_busy" || error.retryable,
          },
        });
    return options.failure(reply, error);
  };
  server.addHook("onRequest", async (request, reply) => {
    if (
      request.url.split("?", 1)[0] === WORKSPACE_FILE_TRANSFER_PATH &&
      !options.authorized(request.headers.authorization)
    )
      return reply.code(401).send({ error: { code: "unauthorized", retryable: false } });
  });
  server.head(WORKSPACE_FILE_TRANSFER_PATH, async (request, reply) => {
    try {
      await options.preflight?.(parse(request.headers["x-pi-cloud-upload"]));
      return reply.code(204).send();
    } catch (error) {
      return failure(reply, error);
    }
  });
  server.post(WORKSPACE_FILE_TRANSFER_PATH, async (request, reply) => {
    const abort = new AbortController();
    const closed = () => {
      if (!reply.raw.writableEnded) abort.abort(new Error("File transfer caller disconnected"));
    };
    reply.raw.on("close", closed);
    try {
      const input = parse(request.headers["x-pi-cloud-upload"]);
      if (
        Number(request.headers["content-length"]) !== (input.chunkLength ?? 0) ||
        (input.action === "append" && !(request.body instanceof Readable))
      )
        throw new Error("File transfer body length changed");
      const result = parseWorkspaceFileTransferSnapshot(
        await options.execute(
          input,
          input.action === "append" ? (request.body as Readable) : undefined,
          options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal,
        ),
      );
      if (result.relativePath !== input.relativePath || result.offset > input.byteLength)
        throw new Error("File transfer receipt changed identity");
      return result;
    } catch (error) {
      return failure(reply, error);
    } finally {
      reply.raw.removeListener("close", closed);
    }
  });
}

export async function fileTransferHttp(
  url: URL,
  token: string,
  request: WorkspaceFileTransferRequest,
  chunks?: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<WorkspaceFileTransferSnapshot> {
  return uploadHttp({
    url,
    token,
    metadata: request,
    wireByteLength: request.chunkLength ?? 0,
    omitDigest: true,
    chunks: chunks ?? (async function* () {})(),
    ...(signal ? { signal } : {}),
    receiptTimeoutMs: 300_000,
    read: async (response) => {
      const value = await readUploadReceipt(response);
      if (!response.ok) {
        const error = (
          value as { error?: { code?: string; message?: string; retryable?: boolean } }
        )?.error;
        throw new WorkspaceFileTransferError(
          error?.code ?? "transfer_transport",
          error?.message ?? "Workspace transfer failed",
          error?.retryable === true || response.status >= 500,
        );
      }
      const result = parseWorkspaceFileTransferSnapshot(value);
      if (
        result.relativePath !== request.relativePath ||
        result.offset > request.byteLength ||
        (result.state === "ready" && result.offset !== request.byteLength)
      )
        throw new Error("File transfer receipt changed identity");
      return result;
    },
  });
}
