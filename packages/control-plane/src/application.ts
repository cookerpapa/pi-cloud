import { installBinaryBodyParser } from "./binary-body-parser.ts";
import type { SessionPublicationService } from "./session-publication-service.ts";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiExceptionFilter } from "./api-exception.filter.ts";
import { ControlPlaneModule, type ControlPlaneEventRuntime } from "./control-plane.module.ts";
import type { ControlPlaneStoreOptions } from "./control-plane-store.ts";
import type { SessionEventStreamOptions } from "@pi-cloud/runtime-core/session-event-stream";
import type { SupervisorWebSocketGateway } from "./supervisor-websocket-gateway.ts";
import type { NativeInputBackendFactory } from "./queued-input-service.ts";
import type { SupervisorProvisioningGateway } from "./supervisor-boot-provisioner.ts";
import type { ProductionHttpGateway } from "./production-http-gateway.ts";
import type { PublicTenantRegistrationConfiguration } from "./public-tenant-registration.ts";
import type { TrustedWorkspaceBrowser } from "./workspace-browser-service.ts";
import type { WebAuthenticationService } from "./web-authentication.ts";
import type { PlatformRuntimeSettingsService } from "./platform-runtime-settings.ts";
import type { WorkspaceTerminalGateway } from "./workspace-terminal-gateway.ts";
import type { DevelopmentEnvironmentService } from "./development-environment-service.ts";
import type { SandboxPreviewGateway } from "./sandbox-preview-gateway.ts";
import type { SshAccessTicketService } from "./ssh-access-ticket-service.ts";
import type { SourceControlService } from "./source-control-service.ts";
import type { ToolProgressIngress } from "./tool-progress-ingress.ts";
import type { RunActivityIngress } from "./run-activity-ingress.ts";
import type { WorkspaceUploader } from "./workspace-upload-service.ts";
import type {
  ImageAttachmentStore,
  ImageUploadStore,
  ImageAttachmentSource,
} from "@pi-cloud/session-attachments";

export type ControlPlaneApplicationOptions = Omit<
  ControlPlaneStoreOptions,
  "tenantId" | "defaultModelProfileId"
> & {
  executionTargets?: import("./execution-target-service.ts").ExecutionTargetService;
  schedules?: import("./session-schedule-service.ts").SessionScheduleService;
  executionTargetIngress?: import("./execution-target-ingress.ts").ExecutionTargetIngress;
  tenantId?: string;
  defaultModelProfileId?: string;
  supervisorWebSocketGateway?: SupervisorWebSocketGateway;
  nativeInputBackendFactory?: NativeInputBackendFactory;
  supervisorProvisioningGateway?: SupervisorProvisioningGateway;
  productionHttpGateway?: ProductionHttpGateway;
  sessionEventStreamOptions?: SessionEventStreamOptions;
  eventRuntime: ControlPlaneEventRuntime;
  publicRegistration?: PublicTenantRegistrationConfiguration;
  workspaceBrowser?: TrustedWorkspaceBrowser;
  workspaceUploader?: WorkspaceUploader;
  imageAttachmentStore?: ImageAttachmentStore & ImageUploadStore & ImageAttachmentSource;
  webAuthentication?: WebAuthenticationService;
  platformOperatorTenantId?: string;
  platformModelSourceTenantId?: string;
  cubeEgressConfigToken?: string;
  platformRuntimeSettings?: PlatformRuntimeSettingsService;
  workspaceTerminalGateway?: WorkspaceTerminalGateway;
  developmentEnvironmentService?: DevelopmentEnvironmentService;
  sandboxPreviewGateway?: SandboxPreviewGateway;
  sshAccessTicketService?: SshAccessTicketService;
  sourceControlService?: SourceControlService;
  toolProgressIngress?: ToolProgressIngress;
  runActivityIngress?: RunActivityIngress;
  sessionPublicationService?: SessionPublicationService;
};

export async function createControlPlaneApplication(
  options: ControlPlaneApplicationOptions,
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({ logger: false });
  installBinaryBodyParser(adapter.getInstance());
  options.productionHttpGateway?.install(adapter.getInstance());
  options.toolProgressIngress?.install(adapter.getInstance());
  options.runActivityIngress?.install(adapter.getInstance());
  options.sessionPublicationService?.install(adapter.getInstance());
  options.executionTargetIngress?.install(adapter.getInstance());
  options.supervisorProvisioningGateway?.install(adapter.getInstance());
  options.supervisorWebSocketGateway?.install(adapter.getInstance());
  options.workspaceTerminalGateway?.install(adapter.getInstance());
  options.sandboxPreviewGateway?.install(adapter.getInstance());
  let staticRequestIdentity;
  if (options.productionHttpGateway === undefined) {
    if (options.tenantId === undefined || options.defaultModelProfileId === undefined) {
      throw new TypeError(
        "Development control plane requires an explicit static tenant and model profile",
      );
    }
    staticRequestIdentity = {
      credentialId: "00000000-0000-4000-8000-000000000000",
      tenantId: options.tenantId,
      tenantSlug: "development",
      userId: "00000000-0000-4000-8000-000000000001",
      displayName: "Development Operator",
      role: "owner" as const,
      defaultModelProfileId: options.defaultModelProfileId,
    };
  }
  const application = await NestFactory.create<NestFastifyApplication>(
    ControlPlaneModule.register({
      ...options,
      ...(staticRequestIdentity === undefined ? {} : { staticRequestIdentity }),
    }),
    adapter,
    { logger: false, rawBody: true },
  );
  application.useGlobalFilters(new ApiExceptionFilter());
  await application.init();
  return application;
}
