import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import {
  SKILL_ENVELOPE_BYTES,
  parseSkillImport,
  parseSkillInstallationChange,
  parseUuidPathParameter,
  ControlPlaneApiValidationError,
} from "@pi-cloud/protocol";
import { TenantRequestContext } from "./tenant-request-context.ts";
import { SkillMarketService } from "./skill-market-service.ts";

@Controller("v1/skills")
export class SkillMarketController {
  constructor(
    @Inject(SkillMarketService) private readonly skills: SkillMarketService,
    @Inject(TenantRequestContext) private readonly identity: TenantRequestContext,
  ) {}

  @Get()
  list(
    @Req() request: FastifyRequest,
    @Query("projectId") projectId?: unknown,
    @Query("cursor") cursor?: unknown,
  ) {
    return this.skills.list(
      this.identity.resolve(request),
      projectId === undefined ? undefined : parseUuidPathParameter(projectId, "projectId"),
      cursor === undefined ? undefined : parseUuidPathParameter(cursor, "cursor"),
    );
  }
  @Post("imports")
  @RouteConfig({ piCloudStreamUpload: true })
  async publish(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ) {
    const actor = this.identity.requireMutation(request);
    if (!(body instanceof Readable))
      throw new ControlPlaneApiValidationError("Skill import requires a binary JSON package");
    const abort = new AbortController();
    const closed = () => {
      if (!reply.raw.writableEnded) abort.abort(new Error("Skill import caller disconnected"));
    };
    reply.raw.on("close", closed);
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of body) {
        length += chunk.length;
        if (length > SKILL_ENVELOPE_BYTES)
          throw new TypeError("Skill import exceeds its transport envelope");
        chunks.push(Buffer.from(chunk));
      }
      const input = parseSkillImport(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      return await this.skills.publish(
        actor,
        input,
        AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
      );
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError)
        throw new ControlPlaneApiValidationError(error.message);
      throw error;
    } finally {
      reply.raw.removeListener("close", closed);
    }
  }
  @Put(":id/installation")
  install(@Req() request: FastifyRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const actor = this.identity.requireMutation(request);
    return this.skills.install(actor, parseUuidPathParameter(id, "id"), this.#change(body));
  }
  @Delete(":id/installation")
  async uninstall(@Req() request: FastifyRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const actor = this.identity.requireMutation(request),
      change = this.#change(body);
    if (!change.revision)
      throw new ControlPlaneApiValidationError("Installation revision is required");
    await this.skills.uninstall(
      actor,
      parseUuidPathParameter(id, "id"),
      change.scope,
      change.revision,
    );
    return { removed: true };
  }
  @Get("versions/:id/files")
  export(@Req() request: FastifyRequest, @Param("id") id: unknown) {
    return this.skills.content(
      this.identity.resolve(request).tenantId,
      parseUuidPathParameter(id, "id"),
    );
  }
  #change(body: unknown) {
    try {
      return parseSkillInstallationChange(body);
    } catch {
      throw new ControlPlaneApiValidationError("Invalid Skill installation change");
    }
  }
}
