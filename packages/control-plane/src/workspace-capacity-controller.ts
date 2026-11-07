import { Body, Controller, Get, Inject, NotFoundException, Param, Put, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import {
  ControlPlaneApiValidationError,
  parseUuidPathParameter,
  parseWorkspaceCapacityChange,
} from "@pi-cloud/protocol";
import { TenantRequestContext } from "./tenant-request-context.ts";
import { WorkspaceCapacityService } from "./workspace-capacity-service.ts";

@Controller("v1/workspaces")
export class WorkspaceCapacityController {
  constructor(
    @Inject(WorkspaceCapacityService) readonly service: WorkspaceCapacityService,
    @Inject(TenantRequestContext) readonly identity: TenantRequestContext,
  ) {}
  @Get(":id/capacity")
  async read(@Req() request: FastifyRequest, @Param("id") id: string) {
    const actor = this.identity.resolve(request),
      result = await this.service.read(actor.tenantId, parseUuidPathParameter(id, "workspaceId"));
    if (!result) throw new NotFoundException("Workspace is unavailable");
    return result;
  }
  @Put(":id/capacity")
  async grow(@Req() request: FastifyRequest, @Param("id") id: string, @Body() body: unknown) {
    const actor = this.identity.requireMutation(request);
    let input;
    try {
      input = parseWorkspaceCapacityChange(body);
    } catch {
      throw new ControlPlaneApiValidationError("Invalid Workspace capacity");
    }
    const result = await this.service.grow(
      actor.tenantId,
      parseUuidPathParameter(id, "workspaceId"),
      input.minimumGiB,
    );
    if (!result) throw new NotFoundException("Workspace is unavailable");
    return result;
  }
}
