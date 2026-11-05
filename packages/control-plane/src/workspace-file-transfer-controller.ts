import {
  Controller,
  Inject,
  Post,
  Get,
  Head,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  Res,
} from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { Server, DataStore, Upload } from "@tus/server";
import { WORKSPACE_TRANSFER_CHUNK_BYTES, parseUuidPathParameter } from "@pi-cloud/protocol";
import { TenantRequestContext } from "./tenant-request-context.ts";
import {
  WorkspaceFileTransferService,
  type WorkspaceTransferActor,
} from "./workspace-file-transfer-service.ts";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

function integer(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new ControlPlaneStoreError("invalid_request", "Invalid upload position or length");
  return Number(value);
}

/** tus implements HTTP continuation; PiCloud retains authenticated admission and
 * the existing remote filesystem authority rather than a local tus FileStore. */
@Controller("v1")
export class WorkspaceFileTransferController {
  constructor(
    @Inject(TenantRequestContext) private readonly tenants: TenantRequestContext,
    @Inject(WorkspaceFileTransferService) private readonly transfers: WorkspaceFileTransferService,
  ) {}

  #actor(request: FastifyRequest, session: string, id: string): WorkspaceTransferActor {
    const identity = this.tenants.requireMutation(request);
    return {
      tenantId: identity.tenantId,
      userId: identity.userId,
      sessionId: parseUuidPathParameter(session, "sessionId").toLowerCase(),
      uploadId: parseUuidPathParameter(id, "uploadId").toLowerCase(),
    };
  }

  @Post("sessions/:sessionId/workspace-files/:uploadId")
  create(
    @Req() request: FastifyRequest,
    @Param("sessionId") session: string,
    @Param("uploadId") id: string,
    @Body() body: unknown,
  ) {
    return this.transfers.create(this.#actor(request, session, id), body);
  }
  @Get("sessions/:sessionId/workspace-files/:uploadId")
  status(
    @Req() request: FastifyRequest,
    @Param("sessionId") session: string,
    @Param("uploadId") id: string,
  ) {
    return this.transfers.status(this.#actor(request, session, id));
  }
  @Delete("sessions/:sessionId/workspace-files/:uploadId")
  cancel(
    @Req() request: FastifyRequest,
    @Param("sessionId") session: string,
    @Param("uploadId") id: string,
  ) {
    return this.transfers.cancel(this.#actor(request, session, id));
  }
  @Head("sessions/:sessionId/workspace-files/:uploadId/content")
  head(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param("sessionId") session: string,
    @Param("uploadId") id: string,
  ) {
    return this.#content(request, reply, this.#actor(request, session, id));
  }
  @RouteConfig({ piCloudStreamUpload: true })
  @Patch("sessions/:sessionId/workspace-files/:uploadId/content")
  patch(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param("sessionId") session: string,
    @Param("uploadId") id: string,
  ) {
    return this.#content(request, reply, this.#actor(request, session, id));
  }

  async #content(request: FastifyRequest, reply: FastifyReply, actor: WorkspaceTransferActor) {
    const service = this.transfers,
      abort = new AbortController();
    const closed = () => {
      if (!reply.raw.writableEnded) abort.abort(new Error("Upload client disconnected"));
    };
    reply.raw.on("close", closed);
    try {
      let length = 0;
      if (request.method === "PATCH") {
        length = integer(request.headers["content-length"]);
        integer(request.headers["upload-offset"]);
        if (
          length < 1 ||
          length > WORKSPACE_TRANSFER_CHUNK_BYTES ||
          !(request.body instanceof Readable)
        )
          throw new ControlPlaneStoreError("invalid_request", "Invalid Workspace upload chunk");
      }
      class RemoteWorkspaceStore extends DataStore {
        override async getUpload(id: string) {
          if (id !== actor.uploadId) throw new Error("Upload identity changed");
          const resource = await service.status(actor, abort.signal);
          if (resource.state === "cancelled")
            throw { status_code: 410, body: "Upload was cancelled" };
          return new Upload({ id, size: resource.byteLength, offset: resource.offset });
        }
        override async write(stream: Readable, id: string, offset: number) {
          if (id !== actor.uploadId) throw new Error("Upload identity changed");
          return (await service.append(actor, offset, length, stream, abort.signal)).offset;
        }
      }
      const server = new Server({
        path: `/v1/sessions/${actor.sessionId}/workspace-files`,
        getFileIdFromRequest: () => actor.uploadId,
        datastore: new RemoteWorkspaceStore(),
        onResponseError: (_req, error) => {
          const code = (error as { code?: string }).code;
          if (!code) return undefined;
          const status =
            (error as { retryable?: boolean }).retryable === true
              ? 503
              : code === "not_found" || code === "transfer_missing"
                ? 404
                : code === "transfer_expired" || code === "transfer_cancelled"
                  ? 410
                  : code === "transfer_busy" || code === "control_plane_misconfigured"
                    ? 503
                    : 409;
          return {
            status_code: status,
            body: error instanceof Error ? error.message : "Workspace transfer failed",
          };
        },
      });
      const headers = new Headers();
      for (const name of [
        "content-type",
        "content-length",
        "tus-resumable",
        "upload-offset",
        "upload-length",
      ])
        if (typeof request.headers[name] === "string") headers.set(name, request.headers[name]);
      const init = {
        method: request.method,
        headers,
        signal: abort.signal,
        ...(request.method === "PATCH"
          ? { body: Readable.toWeb(request.body as Readable), duplex: "half" }
          : {}),
      };
      const response = await server.handleWeb(
        new Request(`http://upload.local${request.url}`, init as RequestInit),
      );
      response.headers.forEach((value, name) => reply.header(name, value));
      return reply
        .code(response.status)
        .send(
          request.method === "HEAD" || response.status === 204
            ? undefined
            : Buffer.from(await response.arrayBuffer()),
        );
    } finally {
      reply.raw.removeListener("close", closed);
    }
  }
}
