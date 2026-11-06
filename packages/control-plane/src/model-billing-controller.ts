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
import { ModelMeteringService, MeteringConflict } from "./model-metering-service.ts";
import { TenantRequestContext } from "./tenant-request-context.ts";

export function modelBillingQuery(query: Record<string, unknown>) {
  const date = (value: unknown, fallback: string) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || value.length > 30 || !Number.isFinite(Date.parse(value)))
      throw new ControlPlaneApiValidationError("Invalid billing date");
    return new Date(value).toISOString();
  };
  const now = new Date(),
    from = date(
      query.from,
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    );
  const to = date(query.to, now.toISOString());
  if (from >= to)
    throw new ControlPlaneApiValidationError("Billing period must end after it starts");
  if (query.model !== undefined && (typeof query.model !== "string" || query.model.length > 256))
    throw new ControlPlaneApiValidationError("Invalid model filter");
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new ControlPlaneApiValidationError("Billing page size must be between 1 and 200");
  if ((query.beforeTime === undefined) !== (query.beforeId === undefined))
    throw new ControlPlaneApiValidationError("Incomplete billing cursor");
  return {
    from,
    to,
    limit,
    ...(query.sessionId ? { sessionId: parseUuidPathParameter(query.sessionId, "sessionId") } : {}),
    ...(typeof query.model === "string" && query.model ? { model: query.model } : {}),
    ...(query.beforeId
      ? {
          before: {
            time: date(query.beforeTime, to),
            id: parseUuidPathParameter(query.beforeId, "beforeId"),
          },
        }
      : {}),
  };
}
@Controller("v1/model-billing")
export class ModelBillingController {
  constructor(
    @Inject(ModelMeteringService) private readonly service: ModelMeteringService,
    @Inject(TenantRequestContext) private readonly identity: TenantRequestContext,
    @Inject("MODEL_BILLING_OPERATOR") private readonly operator: string | null,
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
    return this.service.list(this.tenant(request, query.tenantId), modelBillingQuery(query));
  }
  @Get("rates")
  rates(@Req() request: FastifyRequest, @Query("tenantId") tenantId?: unknown) {
    return this.service.rates(this.tenant(request, tenantId));
  }
  @Get("summary")
  summary(@Req() request: FastifyRequest, @Query() query: Record<string, unknown>) {
    return this.service.summary(this.tenant(request, query.tenantId), modelBillingQuery(query));
  }
  @Post("rates")
  async createRate(
    @Req() request: FastifyRequest,
    @Query("tenantId") tenantId: unknown,
    @Body() body: unknown,
  ) {
    const actor = this.identity.requireOwner(request);
    if (actor.tenantId !== this.operator)
      throw new ForbiddenException("Only the platform operator can configure model rates");
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
      options = modelBillingQuery(query),
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
      .header("content-disposition", 'attachment; filename="model-usage.ndjson"')
      .send(stream);
  }
}
