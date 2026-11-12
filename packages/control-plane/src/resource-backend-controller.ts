import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Req,
  Inject,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ResourceBackendService, ResourceBackendChangeError } from "./resource-backend-service.ts";
import { TenantRequestContext } from "./tenant-request-context.ts";
import { PlatformRuntimeSettingsService } from "./platform-runtime-settings.ts";

@Controller("v1/resource-backends")
export class ResourceBackendController {
  constructor(
    @Inject(ResourceBackendService) readonly service: ResourceBackendService,
    @Inject(TenantRequestContext) readonly identity: TenantRequestContext,
    @Inject(PlatformRuntimeSettingsService) readonly settings: PlatformRuntimeSettingsService,
  ) {}
  @Get()
  list(@Req() request: FastifyRequest) {
    this.identity.resolve(request);
    return this.service.catalog();
  }
  @Get("admin")
  admin(@Req() request: FastifyRequest) {
    this.#authorize(request);
    return this.service.catalog(true);
  }
  #authorize(request: FastifyRequest) {
    if (!this.settings.isPlatformAdministrator(this.identity.requireMutation(request)))
      throw new ForbiddenException(
        "Only the platform administrator can register resource backends",
      );
  }
  @Put()
  async put(@Req() request: FastifyRequest, @Body() body: unknown) {
    this.#authorize(request);
    try {
      return await this.service.put(body);
    } catch (error) {
      if (error instanceof ResourceBackendChangeError) throw new ConflictException(error.message);
      if (error instanceof TypeError)
        throw new BadRequestException("Invalid resource backend configuration");
      throw error;
    }
  }
  @Post("devices")
  async registerDevice(@Req() request: FastifyRequest, @Body() body: unknown) {
    this.#authorize(request);
    try {
      return await this.service.registerDevice(this.identity.resolve(request).tenantId, body);
    } catch (error) {
      if (error instanceof ResourceBackendChangeError) throw new ConflictException(error.message);
      if (error instanceof TypeError) throw new BadRequestException("Invalid device registration");
      throw error;
    }
  }
}
