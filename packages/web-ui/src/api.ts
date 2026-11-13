import {
  SessionApi,
  request,
  requestBytes,
  jsonRequest,
  type FetchImplementation,
} from "@pi-cloud/session-client";
import type { WorkspaceCapacitySnapshot } from "@pi-cloud/protocol";
import type { ResourceStatementPage, ResourceBillingSummary } from "@pi-cloud/protocol";
import {
  parseModelBillingPage,
  type ModelBillingPage,
  type ModelBillingSummary,
} from "@pi-cloud/protocol";
import type {
  SkillImport,
  SkillMarket,
  SkillVersion,
  SkillInstallation,
  SkillInstallationChange,
  SkillPackageContent,
} from "@pi-cloud/protocol";
import {
  parseSessionSchedule,
  parseSessionScheduleList,
  parseScheduleDeletion,
  type ScheduleChange,
} from "@pi-cloud/protocol";

import { blobContentDigest } from "./upload-digest.ts";
import { Upload as TusUpload } from "tus-js-client";
import {
  parseWorkspaceFileTransfer,
  WORKSPACE_TRANSFER_CHUNK_BYTES,
  type CreateWorkspaceFileTransfer,
  type WorkspaceFileTransfer,
} from "@pi-cloud/protocol";
import {
  parseUserUpload,
  userUploadSource,
  type UserUpload,
  parseAuthSessionResource,
  parseAuthenticationConfigurationResource,
  parseModelConfigurationResource,
  parseCubeProxyConfigurationResource,
  parseLogoutResource,
  parseProjectResource,
  parseTenantRegistrationResource,
  parseWorkspaceDirectoryResource,
  parseWorkspaceDeletionResource,
  parseDevelopmentEnvironmentListResource,
  parseDevelopmentEnvironmentResource,
  parseDevelopmentEnvironmentDirectoryResource,
  parseWorkspaceListResource,
  parseSshAccessTicketResource,
  parseSourceControlIssueJobListResource,
  parseSourceControlIssueJobResource,
  parseSourceControlIssueGitCredentialResource,
  parseCodeHostConnectionListResource,
  type AuthSessionResource,
  type AuthenticationConfigurationResource,
  type ProjectResource,
  type ProviderModelSelection,
  type ModelConfigurationResource,
  type CubeProxyConfigurationResource,
  type LogoutResource,
  type TenantRegistrationResource,
  type WorkspaceDirectoryResource,
  type WorkspaceDeletionResource,
  type DevelopmentEnvironmentAction,
  type DevelopmentEnvironmentListResource,
  type DevelopmentEnvironmentResource,
  type DevelopmentEnvironmentDirectoryResource,
  type WorkspaceListResource,
  type WorkspaceSourceRequest,
  type SshAccessTicketResource,
  type SourceControlIssueJobListResource,
  type SourceControlIssueJobResource,
  type StartSourceControlIssueJobRequest,
  type SourceControlIssueGitCredentialResource,
  type CodeHostConnectionListResource,
  type ConnectCodeHostRequest,
  type DisconnectCodeHostRequest,
} from "@pi-cloud/protocol";

export class PiCloudApi extends SessionApi {
  readonly #fetch: FetchImplementation;
  readonly #authorizationToken: string | undefined;

  constructor(
    fetchImplementation: FetchImplementation = globalThis.fetch.bind(globalThis),
    authorizationToken?: string,
  ) {
    super(fetchImplementation, authorizationToken);
    this.#fetch = fetchImplementation;
    this.#authorizationToken = authorizationToken;
  }

  async getAuthenticationConfiguration(): Promise<AuthenticationConfigurationResource> {
    return parseAuthenticationConfigurationResource(
      await request(this.#fetch, "/v1/auth/providers", { method: "GET" }),
    );
  }

  async registerAccount(
    username: string,
    displayName: string,
    password: string,
  ): Promise<AuthSessionResource> {
    return parseAuthSessionResource(
      await request(
        this.#fetch,
        "/v1/auth/register",
        jsonRequest({ username, displayName, password }),
      ),
    );
  }

  async loginAccount(username: string, password: string): Promise<AuthSessionResource> {
    return parseAuthSessionResource(
      await request(this.#fetch, "/v1/auth/login", jsonRequest({ username, password })),
    );
  }

  async logout(): Promise<LogoutResource> {
    return parseLogoutResource(await request(this.#fetch, "/v1/auth/logout", jsonRequest({})));
  }

  async getModelConfiguration(): Promise<ModelConfigurationResource> {
    return parseModelConfigurationResource(
      await request(
        this.#fetch,
        "/v1/model-configuration",
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async replaceModelConfiguration(
    selection: ProviderModelSelection,
  ): Promise<ModelConfigurationResource> {
    return parseModelConfigurationResource(
      await request(
        this.#fetch,
        "/v1/model-configuration",
        jsonRequest(selection, undefined, "PUT"),
        this.#authorizationToken,
      ),
    );
  }

  async getCubeProxyConfiguration(): Promise<CubeProxyConfigurationResource> {
    return parseCubeProxyConfigurationResource(
      await request(
        this.#fetch,
        "/v1/platform-settings/cube-proxy",
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async replaceCubeProxyConfiguration(
    enabled: boolean,
    proxyUrl?: string,
  ): Promise<CubeProxyConfigurationResource> {
    return parseCubeProxyConfigurationResource(
      await request(
        this.#fetch,
        "/v1/platform-settings/cube-proxy",
        jsonRequest({ enabled, ...(proxyUrl === undefined ? {} : { proxyUrl }) }, undefined, "PUT"),
        this.#authorizationToken,
      ),
    );
  }

  async registerTenant(
    tenantSlug: string,
    displayName: string,
  ): Promise<TenantRegistrationResource> {
    return parseTenantRegistrationResource(
      await request(this.#fetch, "/v1/registrations", jsonRequest({ tenantSlug, displayName })),
    );
  }

  async listWorkspaces(): Promise<WorkspaceListResource> {
    return parseWorkspaceListResource(
      await request(this.#fetch, "/v1/workspaces", { method: "GET" }, this.#authorizationToken),
    );
  }

  async listSourceControlIssueJobs(): Promise<SourceControlIssueJobListResource> {
    return parseSourceControlIssueJobListResource(
      await request(
        this.#fetch,
        "/v1/source-control/issue-jobs",
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async claimSourceControlIssueJob(jobId: string): Promise<SourceControlIssueJobResource> {
    return parseSourceControlIssueJobResource(
      await request(
        this.#fetch,
        `/v1/source-control/issue-jobs/${encodeURIComponent(jobId)}/claims`,
        jsonRequest({}),
        this.#authorizationToken,
      ),
    );
  }

  async unclaimSourceControlIssueJob(jobId: string): Promise<SourceControlIssueJobResource> {
    return parseSourceControlIssueJobResource(
      await request(
        this.#fetch,
        `/v1/source-control/issue-jobs/${encodeURIComponent(jobId)}/claims`,
        { method: "DELETE" },
        this.#authorizationToken,
      ),
    );
  }

  async startSourceControlIssueJob(
    jobId: string,
    input: StartSourceControlIssueJobRequest,
  ): Promise<SourceControlIssueJobResource> {
    return parseSourceControlIssueJobResource(
      await request(
        this.#fetch,
        `/v1/source-control/issue-jobs/${encodeURIComponent(jobId)}/start`,
        jsonRequest(input),
        this.#authorizationToken,
      ),
    );
  }

  async preflightSourceControlIssueGit(
    jobId: string,
    workspaceId: string,
  ): Promise<SourceControlIssueGitCredentialResource> {
    return parseSourceControlIssueGitCredentialResource(
      await request(
        this.#fetch,
        `/v1/source-control/issue-jobs/${encodeURIComponent(jobId)}/git-preflight`,
        jsonRequest({ workspaceId }),
        this.#authorizationToken,
      ),
    );
  }

  async codeHostConnections(workspaceId: string): Promise<CodeHostConnectionListResource> {
    return parseCodeHostConnectionListResource(
      await request(
        this.#fetch,
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/code-host-connections`,
        {},
        this.#authorizationToken,
      ),
    );
  }

  async connectCodeHost(
    workspaceId: string,
    input: ConnectCodeHostRequest,
  ): Promise<CodeHostConnectionListResource> {
    return parseCodeHostConnectionListResource(
      await request(
        this.#fetch,
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/code-host-connections`,
        jsonRequest(input),
        this.#authorizationToken,
      ),
    );
  }

  async disconnectCodeHost(
    workspaceId: string,
    input: DisconnectCodeHostRequest,
  ): Promise<CodeHostConnectionListResource> {
    return parseCodeHostConnectionListResource(
      await request(
        this.#fetch,
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/code-host-connections`,
        jsonRequest(input, undefined, "DELETE"),
        this.#authorizationToken,
      ),
    );
  }

  async deleteWorkspace(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<WorkspaceDeletionResource> {
    return parseWorkspaceDeletionResource(
      await request(
        this.#fetch,
        `/v1/workspaces/${encodeURIComponent(workspaceId)}`,
        {
          method: "DELETE",
          headers: { "idempotency-key": idempotencyKey },
        },
        this.#authorizationToken,
      ),
    );
  }

  async listDevelopmentEnvironments(): Promise<DevelopmentEnvironmentListResource> {
    return parseDevelopmentEnvironmentListResource(
      await request(
        this.#fetch,
        "/v1/development-environments",
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async workspaceCapacity(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceCapacitySnapshot> {
    return (await request(
      this.#fetch,
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/capacity`,
      { method: "GET", ...(signal ? { signal } : {}) },
      this.#authorizationToken,
    )) as WorkspaceCapacitySnapshot;
  }
  async growWorkspaceCapacity(
    workspaceId: string,
    minimumGiB: number,
  ): Promise<WorkspaceCapacitySnapshot> {
    return (await request(
      this.#fetch,
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/capacity`,
      { ...jsonRequest({ minimumGiB }), method: "PUT" },
      this.#authorizationToken,
    )) as WorkspaceCapacitySnapshot;
  }
  async registerResourceDevice(
    input: import("@pi-cloud/protocol").RegisterResourceDeviceRequest,
  ): Promise<void> {
    await request(
      this.#fetch,
      "/v1/resource-backends/devices",
      jsonRequest(input),
      this.#authorizationToken,
    );
  }
  async resourceBackends(
    administrator = false,
  ): Promise<{ backends: readonly import("@pi-cloud/protocol").ResourceBackendResource[] }> {
    return (await request(
      this.#fetch,
      `/v1/resource-backends${administrator ? "/admin" : ""}`,
      { method: "GET" },
      this.#authorizationToken,
    )) as { backends: import("@pi-cloud/protocol").ResourceBackendResource[] };
  }
  async putResourceBackend(
    input: import("@pi-cloud/protocol").PutResourceBackend,
  ): Promise<import("@pi-cloud/protocol").ResourceBackendResource> {
    return (await request(
      this.#fetch,
      "/v1/resource-backends",
      { ...jsonRequest(input), method: "PUT" },
      this.#authorizationToken,
    )) as import("@pi-cloud/protocol").ResourceBackendResource;
  }
  async createDevelopmentEnvironment(
    name: string,
    profileKey: import("@pi-cloud/protocol").DevelopmentEnvironmentProfileKey,
    idempotencyKey: string,
    workspaceCapacityGiB?: number,
    backend?: import("@pi-cloud/protocol").CreateDevelopmentEnvironmentRequest["backend"],
  ): Promise<DevelopmentEnvironmentResource> {
    return parseDevelopmentEnvironmentResource(
      await request(
        this.#fetch,
        "/v1/development-environments",
        jsonRequest(
          {
            name,
            profileKey,
            ...(backend ? { backend } : {}),
            ...(workspaceCapacityGiB === undefined ? {} : { workspaceCapacityGiB }),
          },
          idempotencyKey,
        ),
        this.#authorizationToken,
      ),
    );
  }

  async developmentEnvironmentAction(
    environmentId: string,
    action: DevelopmentEnvironmentAction,
    idempotencyKey: string,
  ): Promise<DevelopmentEnvironmentResource> {
    return parseDevelopmentEnvironmentResource(
      await request(
        this.#fetch,
        `/v1/development-environments/${encodeURIComponent(environmentId)}/actions`,
        jsonRequest({ action }, idempotencyKey),
        this.#authorizationToken,
      ),
    );
  }

  async listDevelopmentEnvironmentDirectory(
    environmentId: string,
    path: string,
  ): Promise<DevelopmentEnvironmentDirectoryResource> {
    return parseDevelopmentEnvironmentDirectoryResource(
      await request(
        this.#fetch,
        `/v1/development-environments/${encodeURIComponent(environmentId)}/directory?path=${encodeURIComponent(path)}`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async createDevelopmentEnvironmentDirectory(
    environmentId: string,
    path: string,
    name: string,
  ): Promise<DevelopmentEnvironmentDirectoryResource> {
    return parseDevelopmentEnvironmentDirectoryResource(
      await request(
        this.#fetch,
        `/v1/development-environments/${encodeURIComponent(environmentId)}/directory`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, name }),
        },
        this.#authorizationToken,
      ),
    );
  }

  async issueSshAccessTicket(sessionId: string): Promise<SshAccessTicketResource> {
    return parseSshAccessTicketResource(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/ssh-tickets`,
        jsonRequest({}),
        this.#authorizationToken,
      ),
    );
  }
  async resourceBilling(
    query: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<ResourceStatementPage> {
    return (await request(
      this.#fetch,
      `/v1/resource-billing?${query}`,
      { method: "GET", ...(signal ? { signal } : {}) },
      this.#authorizationToken,
    )) as ResourceStatementPage;
  }
  async resourceBillingSummary(
    query: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<ResourceBillingSummary> {
    return (await request(
      this.#fetch,
      `/v1/resource-billing/summary?${query}`,
      { method: "GET", ...(signal ? { signal } : {}) },
      this.#authorizationToken,
    )) as ResourceBillingSummary;
  }
  async modelBilling(query: URLSearchParams, signal?: AbortSignal): Promise<ModelBillingPage> {
    return parseModelBillingPage(
      await request(
        this.#fetch,
        `/v1/model-billing?${query}`,
        { method: "GET", ...(signal ? { signal } : {}) },
        this.#authorizationToken,
      ),
    );
  }
  async modelBillingSummary(
    query: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<ModelBillingSummary> {
    return (await request(
      this.#fetch,
      `/v1/model-billing/summary?${query}`,
      { method: "GET", ...(signal ? { signal } : {}) },
      this.#authorizationToken,
    )) as ModelBillingSummary;
  }
  async listSkills(
    projectId?: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<SkillMarket> {
    const query = new URLSearchParams({
      ...(projectId ? { projectId } : {}),
      ...(cursor ? { cursor } : {}),
    });
    return (await request(
      this.#fetch,
      `/v1/skills?${query}`,
      { method: "GET", ...(signal ? { signal } : {}) },
      this.#authorizationToken,
    )) as SkillMarket;
  }
  async importSkill(input: SkillImport): Promise<SkillVersion> {
    return (await request(
      this.#fetch,
      "/v1/skills/imports",
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: JSON.stringify(input),
      },
      this.#authorizationToken,
    )) as SkillVersion;
  }
  async installSkill(
    packageId: string,
    input: SkillInstallationChange,
  ): Promise<SkillInstallation> {
    return (await request(
      this.#fetch,
      `/v1/skills/${encodeURIComponent(packageId)}/installation`,
      jsonRequest(input, undefined, "PUT"),
      this.#authorizationToken,
    )) as SkillInstallation;
  }
  async uninstallSkill(packageId: string, input: SkillInstallationChange): Promise<void> {
    await request(
      this.#fetch,
      `/v1/skills/${encodeURIComponent(packageId)}/installation`,
      jsonRequest(input, undefined, "DELETE"),
      this.#authorizationToken,
    );
  }
  async exportSkill(versionId: string): Promise<SkillPackageContent> {
    return (await request(
      this.#fetch,
      `/v1/skills/versions/${encodeURIComponent(versionId)}/files`,
      { method: "GET" },
      this.#authorizationToken,
    )) as SkillPackageContent;
  }
  async listSchedules(sessionId: string, cursor?: string, signal?: AbortSignal) {
    return parseSessionScheduleList(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/schedules${cursor ? "?cursor=" + encodeURIComponent(cursor) : ""}`,
        { method: "GET", ...(signal ? { signal } : {}) },
        this.#authorizationToken,
      ),
    );
  }
  async getSchedule(sessionId: string, id: string, signal?: AbortSignal) {
    return parseSessionSchedule(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/schedules/${encodeURIComponent(id)}`,
        { method: "GET", ...(signal ? { signal } : {}) },
        this.#authorizationToken,
      ),
    );
  }
  async changeSchedule(sessionId: string, id: string, input: ScheduleChange) {
    return parseSessionSchedule(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/schedules/${encodeURIComponent(id)}`,
        jsonRequest(input, undefined, "PATCH"),
        this.#authorizationToken,
      ),
    );
  }
  async deleteSchedule(sessionId: string, id: string, revision: string) {
    return parseScheduleDeletion(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/schedules/${encodeURIComponent(id)}`,
        jsonRequest({ revision }, undefined, "DELETE"),
        this.#authorizationToken,
      ),
    );
  }

  async listWorkspaceDirectory(sessionId: string, path = ""): Promise<WorkspaceDirectoryResource> {
    const query = path.length === 0 ? "" : `?path=${encodeURIComponent(path)}`;
    return parseWorkspaceDirectoryResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/workspace/directory${query}`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  readWorkspaceFile(
    sessionId: string,
    path: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    return requestBytes(
      this.#fetch,
      `/v1/sessions/${encodeURIComponent(sessionId)}/workspace/file?path=${encodeURIComponent(path)}`,
      this.#authorizationToken,
    );
  }

  async createProject(
    name: string,
    source: WorkspaceSourceRequest = { kind: "empty" },
    backend?: import("@pi-cloud/protocol").ResourceBackendSelection,
  ): Promise<ProjectResource> {
    return parseProjectResource(
      await request(
        this.#fetch,
        "/v1/projects",
        jsonRequest({ name, source, ...(backend ? { backend } : {}) }),
        this.#authorizationToken,
      ),
    );
  }

  async uploadWorkspaceFile(
    sessionId: string,
    id: string,
    file: Blob,
    name: string,
    signal?: AbortSignal,
  ): Promise<UserUpload> {
    return parseUserUpload(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/uploads/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "content-digest": await blobContentDigest(file, signal),
          },
          body: file,
          signal: signal ?? null,
        },
        this.#authorizationToken,
      ),
    );
  }

  async createWorkspaceFileTransfer(
    sessionId: string,
    id: string,
    input: CreateWorkspaceFileTransfer,
    signal?: AbortSignal,
  ) {
    return parseWorkspaceFileTransfer(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/workspace-files/${encodeURIComponent(id)}`,
        { ...jsonRequest(input), signal: signal ?? null },
        this.#authorizationToken,
      ),
    );
  }

  async workspaceFileTransfer(sessionId: string, id: string, signal?: AbortSignal) {
    return parseWorkspaceFileTransfer(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/workspace-files/${encodeURIComponent(id)}`,
        { method: "GET", signal: signal ?? null },
        this.#authorizationToken,
      ),
    );
  }

  async cancelWorkspaceFileTransfer(sessionId: string, id: string) {
    return parseWorkspaceFileTransfer(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/workspace-files/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        this.#authorizationToken,
      ),
    );
  }

  async continueWorkspaceFileTransfer(
    transfer: WorkspaceFileTransfer,
    file: File,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ): Promise<WorkspaceFileTransfer> {
    signal.throwIfAborted();
    if (transfer.state === "ready") return transfer;
    const path = `/v1/sessions/${encodeURIComponent(transfer.sessionId)}/workspace-files/${encodeURIComponent(transfer.id)}/content`;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const upload = new TusUpload(file, {
        uploadUrl: path,
        chunkSize: WORKSPACE_TRANSFER_CHUNK_BYTES,
        retryDelays: [0, 1000, 3000, 5000],
        storeFingerprintForResuming: false,
        headers: this.#authorizationToken
          ? { authorization: `Bearer ${this.#authorizationToken}` }
          : {},
        onProgress: progress,
        onSuccess: () => finish(),
        onError: finish,
        onShouldRetry: (error) => {
          const status = error.originalResponse?.getStatus();
          return (
            !signal.aborted &&
            (status === undefined ||
              status === 0 ||
              (status === 409 && error.originalResponse?.getBody().includes("offset") === true) ||
              status >= 500)
          );
        },
      });
      const abort = () => {
        void upload
          .abort()
          .then(
            () => finish(signal.reason ?? new DOMException("Upload paused", "AbortError")),
            finish,
          );
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else upload.start();
    });
    const result = await this.workspaceFileTransfer(transfer.sessionId, transfer.id, signal);
    if (result.state !== "ready") throw new Error("Workspace upload has not completed");
    return result;
  }

  async removeDraftUpload(upload: UserUpload): Promise<void> {
    await request(
      this.#fetch,
      `/v1/sessions/${encodeURIComponent(upload.sessionId)}/uploads/${encodeURIComponent(upload.id)}`,
      { method: "DELETE" },
      this.#authorizationToken,
    );
  }

  readInputImage(
    upload: UserUpload,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    return requestBytes(
      this.#fetch,
      `/v1/sessions/${encodeURIComponent(upload.sessionId)}/images/${encodeURIComponent(upload.image!.id)}`,
      this.#authorizationToken,
      signal,
    );
  }

  readInputAttachment(
    upload: UserUpload,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const source = userUploadSource(upload);
    if (!source) return Promise.reject(new Error("Attachment original is unavailable"));
    return requestBytes(
      this.#fetch,
      `/v1/sessions/${encodeURIComponent(upload.sessionId)}/attachments/${encodeURIComponent(source.id)}`,
      this.#authorizationToken,
      signal,
    );
  }

  attachmentDownloadUrl(upload: UserUpload): string {
    const source = userUploadSource(upload);
    if (!source) throw new Error("Attachment original is unavailable");
    return `/v1/sessions/${encodeURIComponent(upload.sessionId)}/attachments/${encodeURIComponent(source.id)}`;
  }

  async reuseInputAttachment(
    targetSessionId: string,
    id: string,
    upload: UserUpload,
    signal?: AbortSignal,
  ): Promise<UserUpload> {
    const source = userUploadSource(upload);
    if (!source) throw new Error("Attachment original is unavailable");
    return parseUserUpload(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(targetSessionId)}/uploads/${encodeURIComponent(id)}/from-attachment`,
        {
          ...jsonRequest({
            sourceSessionId: upload.sessionId,
            attachmentId: source.id,
            name: upload.name,
          }),
          signal: signal ?? null,
        },
        this.#authorizationToken,
      ),
    );
  }
}
