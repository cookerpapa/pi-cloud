import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  parseAcceptTurnRequest,
  parseLoginAccountRequest,
  parseRegisterAccountRequest,
  parseCreateTenantRegistrationRequest,
  parseCreateProjectRequest,
  parseCreateSessionRequest,
  parseCreateTurnCancellationRequest,
  parseCreateTurnSteerRequest,
  parseCreateConversationForkRequest,
  parseCreateConversationPruneRequest,
  parseCreateDevelopmentEnvironmentRequest,
  parseCreateDevelopmentEnvironmentDirectoryRequest,
  parseConnectGitLabProjectRequest,
  parseConnectCodeHostRequest,
  parseDisconnectCodeHostRequest,
  parseStartSourceControlIssueJobRequest,
  parseSourceControlIssueGitCredentialRequest,
  parseDevelopmentEnvironmentActionRequest,
  parseRebindConversationWorkspaceRequest,
  parseConversationTreeView,
  parseIdempotencyKey,
  parseReplaceModelConfigurationRequest,
  parseUpdateSessionModelRequest,
  parseReplaceCubeProxyConfigurationRequest,
  parseUuidPathParameter,
  type AcceptedTurnResource,
  type AuthSessionResource,
  type AcceptedTurnCancellationResource,
  type TurnSteerResource,
  type ConversationDetailResource,
  type ConversationListResource,
  type ConversationTreeResource,
  type ConversationForkResource,
  type ConversationPruneResource,
  type ConversationWorkspaceBindingResource,
  type ProjectResource,
  type ModelConfigurationResource,
  type ModelCatalogResource,
  type SessionModelResource,
  type CubeProxyConfigurationResource,
  type InternalCubeProxyConfigurationResource,
  type RunResource,
  type SessionResource,
  type TenantIdentityResource,
  type TenantRegistrationResource,
  type LogoutResource,
  type WorkspaceDirectoryResource,
  type WorkspaceOperationResource,
  type WorkspaceListResource,
  type WorkspaceDeletionResource,
  type DevelopmentEnvironmentListResource,
  type DevelopmentEnvironmentResource,
  type DevelopmentEnvironmentDirectoryResource,
  type SshAccessTicketResource,
  type SourceControlConfigurationResource,
  type SourceControlInstallLinkResource,
  type SourceControlIssueJobListResource,
  type SourceControlIssueJobResource,
  type SourceControlIssueGitCredentialResource,
  type CodeHostConnectionListResource,
  type AuthenticationConfigurationResource,
} from "@pi-cloud/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ControlPlaneStoreFactory } from "./control-plane-store-factory.ts";
import { PublicTenantRegistrationService } from "./public-tenant-registration.ts";
import { SessionEventStream } from "@pi-cloud/runtime-core/session-event-stream";
import { TenantRequestContext } from "./tenant-request-context.ts";
import { TenantModelConfigurationService } from "./tenant-model-configuration.ts";
import { ConversationArchiveService } from "./conversation-archive-service.ts";
import { WorkspaceBrowserService } from "./workspace-browser-service.ts";
import { readWebSessionCookie, WebAuthenticationService } from "./web-authentication.ts";
import { PlatformRuntimeSettingsService } from "./platform-runtime-settings.ts";
import { TurnSteeringService } from "./turn-steering-service.ts";
import { ConversationTreeService } from "./conversation-tree-service.ts";
import { DevelopmentEnvironmentService } from "./development-environment-service.ts";
import { SshAccessTicketService } from "./ssh-access-ticket-service.ts";
import { SourceControlService } from "./source-control-service.ts";

@Controller("v1")
export class ControlPlaneController {
  constructor(
    @Inject(ControlPlaneStoreFactory) private readonly controlPlaneStores: ControlPlaneStoreFactory,
    @Inject(PublicTenantRegistrationService)
    private readonly publicTenantRegistration: PublicTenantRegistrationService,
    @Inject(TenantRequestContext) private readonly tenantRequestContext: TenantRequestContext,
    @Inject(SessionEventStream) private readonly sessionEventStream: SessionEventStream,
    @Inject(TenantModelConfigurationService)
    private readonly tenantModelConfiguration: TenantModelConfigurationService,
    @Inject(ConversationArchiveService)
    private readonly conversationArchive: ConversationArchiveService,
    @Inject(WorkspaceBrowserService)
    private readonly workspaceBrowser: WorkspaceBrowserService,
    @Inject(WebAuthenticationService)
    private readonly webAuthentication: WebAuthenticationService,
    @Inject(PlatformRuntimeSettingsService)
    private readonly platformRuntimeSettings: PlatformRuntimeSettingsService,
    @Inject(TurnSteeringService)
    private readonly turnSteering: TurnSteeringService,
    @Inject(ConversationTreeService)
    private readonly conversationTrees: ConversationTreeService,
    @Inject(DevelopmentEnvironmentService)
    private readonly developmentEnvironments: DevelopmentEnvironmentService,
    @Inject(SshAccessTicketService)
    private readonly sshAccessTickets: SshAccessTicketService,
    @Inject(SourceControlService) private readonly sourceControl: SourceControlService,
  ) {}

  @Get("auth/providers")
  authenticationProviders(): AuthenticationConfigurationResource {
    return {
      local: {
        login: this.webAuthentication.localLoginEnabled,
        registration: this.webAuthentication.registrationEnabled,
      },
    };
  }

  @Post("auth/register")
  async registerAccount(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSessionResource> {
    const issued = await this.webAuthentication.register(parseRegisterAccountRequest(body));
    reply.header("set-cookie", this.webAuthentication.cookie(issued));
    return issued.resource;
  }

  @Post("auth/login")
  @HttpCode(200)
  async loginAccount(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSessionResource> {
    const issued = await this.webAuthentication.login(parseLoginAccountRequest(body));
    reply.header("set-cookie", this.webAuthentication.cookie(issued));
    return issued.resource;
  }

  @Post("auth/logout")
  @HttpCode(200)
  async logoutAccount(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LogoutResource> {
    await this.webAuthentication.logout(readWebSessionCookie(request.headers.cookie));
    reply.header("set-cookie", this.webAuthentication.clearCookie());
    return { loggedOut: true };
  }

  @Post("registrations")
  async registerTenant(@Body() body: unknown): Promise<TenantRegistrationResource> {
    return this.publicTenantRegistration.register(parseCreateTenantRegistrationRequest(body));
  }

  @Get("identity")
  identity(@Req() request: FastifyRequest): TenantIdentityResource {
    const identity = this.tenantRequestContext.resolve(request);
    return {
      tenantId: identity.tenantId,
      tenantSlug: identity.tenantSlug,
      userId: identity.userId,
      ...(identity.username === undefined ? {} : { username: identity.username }),
      displayName: identity.displayName,
      role: identity.role,
      authenticationKind: identity.authenticationKind ?? "local",
      platformAdministrator: this.platformRuntimeSettings.isPlatformAdministrator(identity),
    };
  }

  @Get("model-configuration")
  async getModelConfiguration(@Req() request: FastifyRequest): Promise<ModelConfigurationResource> {
    return this.tenantModelConfiguration.get(this.tenantRequestContext.resolve(request));
  }

  @Put("model-configuration")
  async replaceModelConfiguration(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ModelConfigurationResource> {
    return this.tenantModelConfiguration.replace(
      this.tenantRequestContext.resolve(request),
      parseReplaceModelConfigurationRequest(body),
    );
  }

  @Get("models")
  async getModelCatalog(@Req() request: FastifyRequest): Promise<ModelCatalogResource> {
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores.forIdentity(identity).modelCatalog();
  }

  @Get("sessions/:sessionId/model")
  async getSessionModel(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
  ): Promise<SessionModelResource> {
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores
      .forIdentity(identity)
      .getSessionModel(parseUuidPathParameter(sessionIdValue, "sessionId"));
  }

  @Put("sessions/:sessionId/model")
  async updateSessionModel(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Body() body: unknown,
  ): Promise<SessionModelResource> {
    const identity = this.tenantRequestContext.requireMutation(request);
    return this.controlPlaneStores
      .forIdentity(identity)
      .updateSessionModel(
        parseUuidPathParameter(sessionIdValue, "sessionId"),
        parseUpdateSessionModelRequest(body),
      );
  }

  @Get("platform-settings/cube-proxy")
  async getCubeProxyConfiguration(
    @Req() request: FastifyRequest,
  ): Promise<CubeProxyConfigurationResource> {
    return this.platformRuntimeSettings.get(this.tenantRequestContext.resolve(request));
  }

  @Put("platform-settings/cube-proxy")
  async replaceCubeProxyConfiguration(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<CubeProxyConfigurationResource> {
    return this.platformRuntimeSettings.replace(
      this.tenantRequestContext.resolve(request),
      parseReplaceCubeProxyConfigurationRequest(body),
    );
  }

  @Get("internal/cube-egress-configuration")
  async internalCubeEgressConfiguration(
    @Headers("x-pi-cloud-internal-token") token: string | undefined,
  ): Promise<InternalCubeProxyConfigurationResource> {
    return this.platformRuntimeSettings.internal(token);
  }

  @Post("projects")
  async createProject(
    @Req() httpRequest: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ProjectResource> {
    const request = parseCreateProjectRequest(body);
    const identity = this.tenantRequestContext.requireMutation(httpRequest);
    return this.controlPlaneStores.forIdentity(identity).createProject(request);
  }

  @Get("source-control")
  async sourceControlConfiguration(
    @Req() request: FastifyRequest,
  ): Promise<SourceControlConfigurationResource> {
    return this.sourceControl.configuration(this.tenantRequestContext.resolve(request));
  }

  @Post("source-control/github/installations")
  async beginGitHubInstallation(
    @Req() request: FastifyRequest,
  ): Promise<SourceControlInstallLinkResource> {
    return this.sourceControl.beginGitHubInstall(
      this.tenantRequestContext.requireMutation(request),
    );
  }

  @Get("source-control/github/callback")
  async completeGitHubInstallation(
    @Req() request: FastifyRequest,
    @Query("state") state: unknown,
    @Query("installation_id") installationId: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (typeof state !== "string" || typeof installationId !== "string") {
      throw new TypeError("GitHub installation callback is invalid");
    }
    await this.sourceControl.completeGitHubInstall(
      this.tenantRequestContext.requireMutation(request),
      state,
      installationId,
    );
    reply.code(303).header("location", "/?sourceControl=connected").send();
  }

  @Post("source-control/installations/:installationId/refresh")
  @HttpCode(200)
  async refreshSourceControlInstallation(
    @Req() request: FastifyRequest,
    @Param("installationId") installationIdValue: unknown,
  ): Promise<SourceControlConfigurationResource> {
    const identity = this.tenantRequestContext.requireMutation(request);
    await this.sourceControl.refreshInstallation(
      identity,
      parseUuidPathParameter(installationIdValue, "installationId"),
    );
    return this.sourceControl.configuration(identity);
  }

  @Post("source-control/gitlab/projects")
  @HttpCode(201)
  async connectGitLabProject(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<SourceControlConfigurationResource> {
    return this.sourceControl.connectGitLabProject(
      this.tenantRequestContext.requireMutation(request),
      parseConnectGitLabProjectRequest(body),
    );
  }

  @Get("source-control/issue-jobs")
  async sourceControlIssueJobs(
    @Req() request: FastifyRequest,
  ): Promise<SourceControlIssueJobListResource> {
    return this.sourceControl.listIssueJobs(this.tenantRequestContext.resolve(request));
  }

  @Post("source-control/issue-jobs/:jobId/claims")
  @HttpCode(200)
  async claimSourceControlIssueJob(
    @Req() request: FastifyRequest,
    @Param("jobId") jobIdValue: unknown,
  ): Promise<SourceControlIssueJobResource> {
    return this.sourceControl.claimIssueJob(
      this.tenantRequestContext.requireMutation(request),
      parseUuidPathParameter(jobIdValue, "jobId"),
    );
  }

  @Delete("source-control/issue-jobs/:jobId/claims")
  async unclaimSourceControlIssueJob(
    @Req() request: FastifyRequest,
    @Param("jobId") jobIdValue: unknown,
  ): Promise<SourceControlIssueJobResource> {
    return this.sourceControl.unclaimIssueJob(
      this.tenantRequestContext.requireMutation(request),
      parseUuidPathParameter(jobIdValue, "jobId"),
    );
  }

  @Post("source-control/issue-jobs/:jobId/start")
  @HttpCode(202)
  async startSourceControlIssueJob(
    @Req() request: FastifyRequest,
    @Param("jobId") jobIdValue: unknown,
    @Body() body: unknown,
  ): Promise<SourceControlIssueJobResource> {
    return this.sourceControl.startIssueJob(
      this.tenantRequestContext.requireMutation(request),
      parseUuidPathParameter(jobIdValue, "jobId"),
      parseStartSourceControlIssueJobRequest(body),
    );
  }

  @Post("source-control/issue-jobs/:jobId/git-preflight")
  @HttpCode(200)
  async preflightSourceControlIssueGit(
    @Req() request: FastifyRequest,
    @Param("jobId") jobIdValue: unknown,
    @Body() body: unknown,
  ): Promise<SourceControlIssueGitCredentialResource> {
    const input = parseSourceControlIssueGitCredentialRequest(body);
    return this.sourceControl.preflightIssueGitCredential(
      this.tenantRequestContext.requireMutation(request),
      parseUuidPathParameter(jobIdValue, "jobId"),
      input.workspaceId,
    );
  }

  @Get("workspaces/:workspaceId/code-host-connections")
  async codeHostConnections(
    @Req() request: FastifyRequest,
    @Param("workspaceId") workspaceIdValue: unknown,
  ): Promise<CodeHostConnectionListResource> {
    return this.sourceControl.listCodeHostConnections(
      this.tenantRequestContext.resolve(request),
      parseUuidPathParameter(workspaceIdValue, "workspaceId"),
    );
  }

  @Post("workspaces/:workspaceId/code-host-connections")
  @HttpCode(200)
  async connectCodeHost(
    @Req() request: FastifyRequest,
    @Param("workspaceId") workspaceIdValue: unknown,
    @Body() body: unknown,
  ): Promise<CodeHostConnectionListResource> {
    return this.sourceControl.connectCodeHost(
      this.tenantRequestContext.requireMutation(request),
      parseUuidPathParameter(workspaceIdValue, "workspaceId"),
      parseConnectCodeHostRequest(body),
    );
  }

  @Delete("workspaces/:workspaceId/code-host-connections")
  async disconnectCodeHost(
    @Req() request: FastifyRequest,
    @Param("workspaceId") workspaceIdValue: unknown,
    @Body() body: unknown,
  ): Promise<CodeHostConnectionListResource> {
    const input = parseDisconnectCodeHostRequest(body);
    return this.sourceControl.disconnectCodeHost(
      this.tenantRequestContext.requireMutation(request),
      parseUuidPathParameter(workspaceIdValue, "workspaceId"),
      input.provider,
      input.origin,
    );
  }

  @Post("source-control/github/webhook")
  @HttpCode(202)
  async githubWebhook(
    @Req() request: FastifyRequest & { rawBody?: Buffer },
    @Headers("x-github-delivery") deliveryId: string | undefined,
    @Headers("x-github-event") eventName: string | undefined,
    @Headers("x-hub-signature-256") signature: string | undefined,
  ): Promise<{ accepted: boolean; replayed: boolean }> {
    if (request.rawBody === undefined) throw new TypeError("GitHub Webhook body is unavailable");
    return this.sourceControl.acceptGitHubWebhook({
      deliveryId,
      eventName,
      signature,
      rawBody: request.rawBody,
    });
  }

  @Post("source-control/gitlab/webhook")
  @HttpCode(202)
  async gitlabWebhook(
    @Req() request: FastifyRequest & { rawBody?: Buffer },
    @Headers("webhook-id") deliveryId: string | undefined,
    @Headers("x-gitlab-event") eventName: string | undefined,
    @Headers("x-gitlab-instance") instance: string | undefined,
    @Headers("webhook-timestamp") timestamp: string | undefined,
    @Headers("webhook-signature") signature: string | undefined,
  ): Promise<{ accepted: boolean; replayed: boolean }> {
    if (request.rawBody === undefined) throw new TypeError("GitLab Webhook body is unavailable");
    return this.sourceControl.acceptGitLabWebhook({
      deliveryId,
      eventName,
      instance,
      timestamp,
      signature,
      rawBody: request.rawBody,
    });
  }

  @Get("conversations")
  async listConversations(@Req() request: FastifyRequest): Promise<ConversationListResource> {
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores.forIdentity(identity).listConversations();
  }

  @Get("workspaces")
  async listWorkspaces(@Req() request: FastifyRequest): Promise<WorkspaceListResource> {
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores.forIdentity(identity).listWorkspaces();
  }

  @Get("development-environments")
  async listDevelopmentEnvironments(
    @Req() request: FastifyRequest,
  ): Promise<DevelopmentEnvironmentListResource> {
    return this.developmentEnvironments.list(this.tenantRequestContext.resolve(request));
  }

  @Post("development-environments")
  @HttpCode(201)
  async createDevelopmentEnvironment(
    @Req() request: FastifyRequest,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<DevelopmentEnvironmentResource> {
    return this.developmentEnvironments.create(
      this.tenantRequestContext.requireMutation(request),
      parseIdempotencyKey(idempotencyKeyValue),
      parseCreateDevelopmentEnvironmentRequest(body),
    );
  }

  @Get("development-environments/:environmentId/directory")
  async developmentEnvironmentDirectory(
    @Req() request: FastifyRequest,
    @Param("environmentId") environmentIdValue: unknown,
    @Query("path") pathValue: unknown,
  ): Promise<DevelopmentEnvironmentDirectoryResource> {
    if (typeof pathValue !== "string") {
      throw new Error("Machine directory path is required");
    }
    return this.developmentEnvironments.directory(
      this.tenantRequestContext.resolve(request),
      parseUuidPathParameter(environmentIdValue, "environmentId"),
      pathValue,
    );
  }

  @Post("development-environments/:environmentId/directory")
  @HttpCode(200)
  async createDevelopmentEnvironmentDirectory(
    @Req() request: FastifyRequest,
    @Param("environmentId") environmentIdValue: unknown,
    @Body() body: unknown,
  ): Promise<DevelopmentEnvironmentDirectoryResource> {
    return this.developmentEnvironments.createDirectory(
      this.tenantRequestContext.requireMutation(request),
      parseUuidPathParameter(environmentIdValue, "environmentId"),
      parseCreateDevelopmentEnvironmentDirectoryRequest(body),
    );
  }

  @Post("development-environments/:environmentId/actions")
  @HttpCode(200)
  async developmentEnvironmentAction(
    @Req() request: FastifyRequest,
    @Param("environmentId") environmentIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<DevelopmentEnvironmentResource> {
    return this.developmentEnvironments.action(
      this.tenantRequestContext.requireMutation(request),
      parseUuidPathParameter(environmentIdValue, "environmentId"),
      parseIdempotencyKey(idempotencyKeyValue),
      parseDevelopmentEnvironmentActionRequest(body),
    );
  }

  @Delete("workspaces/:workspaceId")
  async deleteWorkspace(
    @Req() request: FastifyRequest,
    @Param("workspaceId") workspaceIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
  ): Promise<WorkspaceDeletionResource> {
    const workspaceId = parseUuidPathParameter(workspaceIdValue, "workspaceId");
    const identity = this.tenantRequestContext.requireMutation(request);
    return this.controlPlaneStores
      .forIdentity(identity)
      .deleteWorkspace(workspaceId, parseIdempotencyKey(idempotencyKeyValue));
  }

  @Delete("conversations/:sessionId")
  async deleteConversation(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
  ): Promise<WorkspaceOperationResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const identity = this.tenantRequestContext.requireMutation(request);
    return this.conversationArchive.archive(
      identity.tenantId,
      parseIdempotencyKey(idempotencyKeyValue),
      sessionId,
      { archived: true },
    );
  }

  @Put("conversations/:sessionId/workspace")
  async rebindConversationWorkspace(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<ConversationWorkspaceBindingResource> {
    const identity = this.tenantRequestContext.requireMutation(request);
    const binding = parseRebindConversationWorkspaceRequest(body);
    return this.controlPlaneStores
      .forIdentity(identity)
      .rebindConversationWorkspace(
        parseUuidPathParameter(sessionIdValue, "sessionId"),
        binding.workspaceId,
        parseIdempotencyKey(idempotencyKeyValue),
      );
  }

  @Post("conversations/:sessionId/ssh-tickets")
  async issueSshAccessTicket(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
  ): Promise<SshAccessTicketResource> {
    return this.sshAccessTickets.issue(
      this.tenantRequestContext.requireMutation(request),
      parseUuidPathParameter(sessionIdValue, "sessionId"),
    );
  }

  @Get("conversations/:sessionId")
  async getConversation(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
  ): Promise<ConversationDetailResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores.forIdentity(identity).getConversation(sessionId);
  }

  @Get("conversations/:sessionId/tree")
  async getConversationTree(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Query("view") viewValue: unknown,
  ): Promise<ConversationTreeResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const identity = this.tenantRequestContext.resolve(request);
    return this.conversationTrees.tree(
      identity.tenantId,
      sessionId,
      parseConversationTreeView(viewValue),
    );
  }

  @Post("conversations/:sessionId/forks")
  async forkConversation(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<ConversationForkResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const identity = this.tenantRequestContext.requireMutation(request);
    return this.conversationTrees.fork(
      identity.tenantId,
      sessionId,
      parseIdempotencyKey(idempotencyKeyValue),
      parseCreateConversationForkRequest(body),
    );
  }

  @Post("conversations/:sessionId/prunes")
  async pruneConversation(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<ConversationPruneResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const identity = this.tenantRequestContext.requireMutation(request);
    return this.conversationTrees.prune(
      identity.tenantId,
      sessionId,
      parseIdempotencyKey(idempotencyKeyValue),
      parseCreateConversationPruneRequest(body),
    );
  }

  @Get("runs/:runId")
  async getRun(
    @Req() request: FastifyRequest,
    @Param("runId") runIdValue: unknown,
  ): Promise<RunResource> {
    const runId = parseUuidPathParameter(runIdValue, "runId");
    const identity = this.tenantRequestContext.resolve(request);
    return this.controlPlaneStores.forIdentity(identity).getRun(runId);
  }

  @Get("sessions/:sessionId/workspace/directory")
  async listWorkspaceDirectory(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Query("path") pathValue: unknown,
  ): Promise<WorkspaceDirectoryResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const path = pathValue === undefined ? "" : pathValue;
    if (typeof path !== "string") throw new TypeError("Workspace directory path is invalid");
    const identity = this.tenantRequestContext.resolve(request);
    return this.workspaceBrowser.directory(identity.tenantId, sessionId, path);
  }

  @Get("sessions/:sessionId/workspace/file")
  async readWorkspaceFile(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Query("path") path: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    if (typeof path !== "string") throw new TypeError("Workspace file path is required");
    const identity = this.tenantRequestContext.resolve(request);
    const file = await this.workspaceBrowser.file(identity.tenantId, sessionId, path, 512 * 1_024);
    reply
      .header("cache-control", "private, no-store")
      .header("content-type", "application/octet-stream")
      .header("etag", `"${file.sha256}"`)
      .header("x-content-type-options", "nosniff")
      .send(Buffer.from(file.bytes));
  }

  @Post("projects/:projectId/sessions")
  async createSession(
    @Req() httpRequest: FastifyRequest,
    @Param("projectId") projectIdValue: unknown,
    @Body() body: unknown,
  ): Promise<SessionResource> {
    const projectId = parseUuidPathParameter(projectIdValue, "projectId");
    const request = parseCreateSessionRequest(body);
    const identity = this.tenantRequestContext.requireMutation(httpRequest);
    return this.controlPlaneStores
      .forIdentity(identity)
      .createSession(projectId, request.workspaceId, request.title, request.executionMode, {
        ownerUserId: identity.userId,
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.sandboxProfileKey === undefined
          ? {}
          : { sandboxProfileKey: request.sandboxProfileKey }),
        ...(request.workingDirectory === undefined
          ? {}
          : { workingDirectory: request.workingDirectory }),
      });
  }

  @Post("sessions/:sessionId/turns")
  @HttpCode(202)
  async acceptTurn(
    @Req() httpRequest: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<AcceptedTurnResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyValue);
    const request = parseAcceptTurnRequest(body);
    const identity = this.tenantRequestContext.requireMutation(httpRequest);
    return this.controlPlaneStores
      .forIdentity(identity)
      .acceptTurn(sessionId, idempotencyKey, request);
  }

  @Post("sessions/:sessionId/turns/:turnId/cancellations")
  @HttpCode(202)
  async acceptTurnCancellation(
    @Req() httpRequest: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Param("turnId") turnIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<AcceptedTurnCancellationResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const turnId = parseUuidPathParameter(turnIdValue, "turnId");
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyValue);
    const request = parseCreateTurnCancellationRequest(body);
    const identity = this.tenantRequestContext.requireMutation(httpRequest);
    return this.controlPlaneStores
      .forIdentity(identity)
      .acceptTurnCancellation(sessionId, turnId, idempotencyKey, request);
  }

  @Post("sessions/:sessionId/turns/:turnId/steers")
  @HttpCode(200)
  async steerTurn(
    @Req() httpRequest: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Param("turnId") turnIdValue: unknown,
    @Headers("idempotency-key") idempotencyKeyValue: unknown,
    @Body() body: unknown,
  ): Promise<TurnSteerResource> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const turnId = parseUuidPathParameter(turnIdValue, "turnId");
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyValue);
    const request = parseCreateTurnSteerRequest(body);
    const identity = this.tenantRequestContext.requireMutation(httpRequest);
    return this.turnSteering.deliver(identity, sessionId, turnId, idempotencyKey, request);
  }

  @Get("sessions/:sessionId/events")
  async streamSessionEvents(
    @Req() request: FastifyRequest,
    @Param("sessionId") sessionIdValue: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const sessionId = parseUuidPathParameter(sessionIdValue, "sessionId");
    const identity = this.tenantRequestContext.resolve(request);
    const store = this.controlPlaneStores.forIdentity(identity);
    const stream = await this.sessionEventStream.open({
      tenantId: identity.tenantId,
      sessionId,
      loadCanonical: async () => {
        const [conversation, canonicalThroughSequence] = await Promise.all([
          store.getConversation(sessionId),
          store.conversationEventBoundary(sessionId),
        ]);
        return { conversation, canonicalThroughSequence };
      },
    });

    reply.hijack();
    reply.raw.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    reply.raw.flushHeaders();
    try {
      await stream.pipe(reply.raw);
    } catch {
      // The SSE status and headers are already committed. Closing forces the
      // browser to reconnect and receive a replacement Session snapshot.
      reply.raw.destroy();
    } finally {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
  }
}
