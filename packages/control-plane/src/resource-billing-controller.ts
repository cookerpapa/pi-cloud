import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
  Res,
  ForbiddenException,
  ConflictException,
} from "@nestjs/common";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ControlPlaneApiValidationError, parseUuidPathParameter } from "@pi-cloud/protocol";
import {
  ResourceMeteringService,
  MeteringConflict,
  type ResourceBillingQuery,
} from "@pi-cloud/accounting";
import { TenantRequestContext } from "./tenant-request-context.ts";
import { modelBillingQuery } from "./model-billing-controller.ts";

export function resourceBillingQuery(query: Record<string, unknown>): ResourceBillingQuery {
  const { from, to, limit, before } = modelBillingQuery(query);
  if (
    query.resourceKind !== undefined &&
    query.resourceKind !== "compute" &&
    query.resourceKind !== "workspace"
  )
    throw new ControlPlaneApiValidationError("Invalid resource kind");
  return {
    from,
    to,
    limit,
    ...(before ? { before } : {}),
    ...(query.resourceKind ? { resourceKind: query.resourceKind } : {}),
    ...(query.workspaceId
      ? { workspaceId: parseUuidPathParameter(query.workspaceId, "workspaceId") }
      : {}),
  };
}

@Controller("v1/resource-billing")
export class ResourceBillingController {
  constructor(
    @Inject(ResourceMeteringService) private readonly service: ResourceMeteringService,
    @Inject(TenantRequestContext) private readonly identity: TenantRequestContext,
    @Inject("BILLING_OPERATOR") private readonly operator: string | null,
  ) {}
  private tenant(request: FastifyRequest, selected?: unknown) {
    const actor = this.identity.resolve(request);
    if (selected === undefined || selected === actor.tenantId) return actor.tenantId;
    if (actor.tenantId !== this.operator || actor.role !== "owner")
      throw new ForbiddenException("Only the platform operator can inspect another account");
    return parseUuidPathParameter(selected, "tenantId");
  }
  @Get()
  list(@Req() request: FastifyRequest, @Query() query: Record<string, unknown>) {
    if (
      query.afterResourceKey !== undefined &&
      (typeof query.afterResourceKey !== "string" ||
        !query.afterResourceKey ||
        query.afterResourceKey.length > 270)
    )
      throw new ControlPlaneApiValidationError("Invalid resource cursor");
    return this.service.statement(
      this.tenant(request, query.tenantId),
      resourceBillingQuery(query),
      query.afterResourceKey as string | undefined,
    );
  }
  @Get("summary")
  summary(@Req() request: FastifyRequest, @Query() query: Record<string, unknown>) {
    return this.service.summary(this.tenant(request, query.tenantId), resourceBillingQuery(query));
  }
  @Get("rates")
  rates(@Req() request: FastifyRequest, @Query("tenantId") tenantId?: unknown) {
    return this.service.rates(this.tenant(request, tenantId));
  }
  @Post("rates")
  async createRate(
    @Req() request: FastifyRequest,
    @Query("tenantId") tenantId: unknown,
    @Body() body: unknown,
  ) {
    const actor = this.identity.requireOwner(request);
    if (actor.tenantId !== this.operator)
      throw new ForbiddenException("Only the platform operator can configure resource rates");
    try {
      return await this.service.createRate(this.tenant(request, tenantId), body);
    } catch (error) {
      if (error instanceof MeteringConflict) throw new ConflictException(error.message);
      if (error instanceof TypeError) throw new ControlPlaneApiValidationError(error.message);
      throw error;
    }
  }
  @Get("export")
  export(
    @Req() request: FastifyRequest,
    @Query() query: Record<string, unknown>,
    @Res() reply: FastifyReply,
  ) {
    const tenantId = this.tenant(request, query.tenantId),
      options = resourceBillingQuery(query),
      service = this.service;
    const stream = Readable.from(
      (async function* () {
        let before = options.before;
        while (!reply.raw.destroyed) {
          const page = await service.list(tenantId, {
            ...options,
            limit: 200,
            ...(before ? { before } : {}),
          });
          for (const item of page.items) yield `${JSON.stringify(item)}\n`;
          if (!page.next) return;
          before = page.next;
        }
      })(),
    );
    return reply
      .header("content-type", "application/x-ndjson")
      .header("content-disposition", 'attachment; filename="resource-usage.ndjson"')
      .send(stream);
  }
}
