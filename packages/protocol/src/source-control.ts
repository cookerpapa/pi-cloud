import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { OpaqueIdSchema, UtcTimestampSchema, UuidSchema } from "./protocol-primitives.ts";

const ProviderSchema = Type.Union([Type.Literal("github"), Type.Literal("gitlab")]);
const SourceControlTokenSchema = Type.String({
  minLength: 16,
  maxLength: 4_096,
  pattern: "^[^\\r\\n\\u0000]+$",
});
const ProviderBaseUrlSchema = Type.String({
  minLength: 8,
  maxLength: 2_048,
  pattern: "^https?://[^/@\\s]+$",
});
const CloneUrlSchema = Type.String({
  minLength: 12,
  maxLength: 2_048,
  pattern: "^https?://[^/@\\s]+/.+\\.git$",
});

export const SourceControlRepositoryResourceSchema = Type.Object(
  {
    repositoryId: UuidSchema,
    installationId: UuidSchema,
    provider: ProviderSchema,
    providerBaseUrl: ProviderBaseUrlSchema,
    fullName: Type.String({ minLength: 3, maxLength: 511 }),
    private: Type.Boolean(),
    defaultBranch: Type.String({ minLength: 1, maxLength: 255 }),
    state: Type.Union([Type.Literal("active"), Type.Literal("removed")]),
  },
  { additionalProperties: false },
);

export const SourceControlInstallationResourceSchema = Type.Object(
  {
    installationId: UuidSchema,
    provider: ProviderSchema,
    providerBaseUrl: ProviderBaseUrlSchema,
    accountLogin: Type.String({ minLength: 1, maxLength: 255 }),
    accountType: Type.Union([
      Type.Literal("User"),
      Type.Literal("Organization"),
      Type.Literal("Enterprise"),
    ]),
    repositorySelection: Type.Union([Type.Literal("all"), Type.Literal("selected")]),
    state: Type.Union([Type.Literal("active"), Type.Literal("suspended"), Type.Literal("deleted")]),
    installedAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    repositories: Type.Array(SourceControlRepositoryResourceSchema, { maxItems: 5_000 }),
  },
  { additionalProperties: false },
);

export const SourceControlConfigurationResourceSchema = Type.Object(
  {
    githubConfigured: Type.Boolean(),
    gitlabConfigured: Type.Boolean(),
    installations: Type.Array(SourceControlInstallationResourceSchema, { maxItems: 100 }),
  },
  { additionalProperties: false },
);

export const SourceControlInstallLinkResourceSchema = Type.Object(
  {
    provider: ProviderSchema,
    url: Type.String({ minLength: 8, maxLength: 4_096 }),
    expiresAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const SourceControlIssueJobResourceSchema = Type.Object(
  {
    jobId: UuidSchema,
    repositoryId: UuidSchema,
    repositoryFullName: Type.String({ minLength: 3, maxLength: 511 }),
    issueNumber: Type.Integer({ minimum: 1 }),
    issueTitle: Type.String({ minLength: 1, maxLength: 512 }),
    issueUrl: Type.String({ minLength: 8, maxLength: 2_048 }),
    state: Type.Union([
      Type.Literal("awaiting_claim"),
      Type.Literal("received"),
      Type.Literal("provisioning"),
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
    claimEligible: Type.Boolean(),
    claimedByCurrentUser: Type.Boolean(),
    claims: Type.Array(
      Type.Object(
        {
          userId: UuidSchema,
          username: Type.String({ minLength: 1, maxLength: 255 }),
          displayName: Type.String({ minLength: 1, maxLength: 256 }),
          claimedAt: UtcTimestampSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 1_000 },
    ),
    sessionId: Type.Optional(UuidSchema),
    runId: Type.Optional(UuidSchema),
    failure: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const StartSourceControlIssueJobRequestSchema = Type.Union([
  Type.Object(
    {
      executionMode: Type.Literal("elastic"),
      sessionTitle: Type.String({ minLength: 1, maxLength: 256 }),
      sandboxProfileKey: Type.Union([
        Type.Literal("starter"),
        Type.Literal("standard"),
        Type.Literal("performance"),
      ]),
      workspaceId: UuidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      executionMode: Type.Literal("development_environment"),
      sessionTitle: Type.String({ minLength: 1, maxLength: 256 }),
      developmentEnvironmentId: UuidSchema,
      workingDirectory: Type.String({ minLength: 1, maxLength: 4_096, pattern: "^/" }),
    },
    { additionalProperties: false },
  ),
]);

export const ConnectGitLabProjectRequestSchema = Type.Object(
  {
    baseUrl: ProviderBaseUrlSchema,
    project: Type.String({ minLength: 1, maxLength: 511 }),
    accessToken: SourceControlTokenSchema,
  },
  { additionalProperties: false },
);

export const SourceControlIssueJobListResourceSchema = Type.Object(
  { jobs: Type.Array(SourceControlIssueJobResourceSchema, { maxItems: 100 }) },
  { additionalProperties: false },
);

export const SourceControlIssueGitCredentialRequestSchema = Type.Object(
  { workspaceId: UuidSchema },
  { additionalProperties: false },
);

export const SourceControlIssueGitCredentialResourceSchema = Type.Object(
  {
    authorized: Type.Boolean(),
    reason: Type.Optional(
      Type.Union([
        Type.Literal("credential_missing"),
        Type.Literal("credential_rejected"),
        Type.Literal("gitlab_unreachable"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const SourceControlIssueGitAuthorizationLinkResourceSchema = Type.Object(
  {
    url: Type.String({ minLength: 8, maxLength: 4_096 }),
    expiresAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

const GitCredentialMountPathSchema = Type.Union([
  Type.Literal("/workspace"),
  Type.Literal("/home/user"),
]);

export const SourceControlWorkspaceCredentialAuthorizeRequestSchema = Type.Object(
  {
    sourceControlProtocolVersion: Type.Literal(1),
    type: Type.Literal("source_control.workspace_credential_authorize"),
    requestId: UuidSchema,
    tenantId: OpaqueIdSchema,
    workspaceId: UuidSchema,
    repositoryId: UuidSchema,
    provider: ProviderSchema,
    userCloneUrl: CloneUrlSchema,
    verificationCloneUrl: CloneUrlSchema,
    credentialMountPath: GitCredentialMountPathSchema,
    accessToken: SourceControlTokenSchema,
  },
  { additionalProperties: false },
);

export const SourceControlWorkspaceCredentialPreflightRequestSchema = Type.Object(
  {
    sourceControlProtocolVersion: Type.Literal(1),
    type: Type.Literal("source_control.workspace_credential_preflight"),
    requestId: UuidSchema,
    tenantId: OpaqueIdSchema,
    workspaceId: UuidSchema,
    repositoryId: UuidSchema,
    provider: ProviderSchema,
    userCloneUrl: CloneUrlSchema,
    verificationCloneUrl: CloneUrlSchema,
    credentialMountPath: GitCredentialMountPathSchema,
  },
  { additionalProperties: false },
);

export const SourceControlWorkspaceCredentialResponseSchema = Type.Object(
  {
    sourceControlProtocolVersion: Type.Literal(1),
    type: Type.Literal("source_control.workspace_credential_result"),
    requestId: UuidSchema,
    workspaceId: UuidSchema,
    repositoryId: UuidSchema,
    authorized: Type.Boolean(),
    reason: Type.Optional(
      Type.Union([
        Type.Literal("credential_missing"),
        Type.Literal("credential_rejected"),
        Type.Literal("gitlab_unreachable"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export type SourceControlRepositoryResource = Static<typeof SourceControlRepositoryResourceSchema>;
export type SourceControlInstallationResource = Static<
  typeof SourceControlInstallationResourceSchema
>;
export type SourceControlConfigurationResource = Static<
  typeof SourceControlConfigurationResourceSchema
>;
export type SourceControlInstallLinkResource = Static<
  typeof SourceControlInstallLinkResourceSchema
>;
export type SourceControlIssueJobResource = Static<typeof SourceControlIssueJobResourceSchema>;
export type StartSourceControlIssueJobRequest = Static<
  typeof StartSourceControlIssueJobRequestSchema
>;
export type SourceControlIssueJobListResource = Static<
  typeof SourceControlIssueJobListResourceSchema
>;
export type SourceControlIssueGitCredentialRequest = Static<
  typeof SourceControlIssueGitCredentialRequestSchema
>;
export type SourceControlIssueGitCredentialResource = Static<
  typeof SourceControlIssueGitCredentialResourceSchema
>;
export type SourceControlIssueGitAuthorizationLinkResource = Static<
  typeof SourceControlIssueGitAuthorizationLinkResourceSchema
>;
export type ConnectGitLabProjectRequest = Static<typeof ConnectGitLabProjectRequestSchema>;
export type SourceControlWorkspaceCredentialAuthorizeRequest = Static<
  typeof SourceControlWorkspaceCredentialAuthorizeRequestSchema
>;
export type SourceControlWorkspaceCredentialPreflightRequest = Static<
  typeof SourceControlWorkspaceCredentialPreflightRequestSchema
>;
export type SourceControlWorkspaceCredentialResponse = Static<
  typeof SourceControlWorkspaceCredentialResponseSchema
>;

export class SourceControlProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceControlProtocolError";
  }
}

function parse<T>(schema: TSchema, value: unknown, label: string): T {
  if (!Value.Check(schema, value)) {
    const issue = [...Value.Errors(schema, value)][0];
    const location = issue?.instancePath.length ? issue.instancePath : "/";
    throw new SourceControlProtocolError(
      `${label} failed validation at ${location}: ${issue?.message ?? "invalid value"}`,
    );
  }
  return value as T;
}

export const parseSourceControlConfigurationResource = (value: unknown) =>
  parse<SourceControlConfigurationResource>(
    SourceControlConfigurationResourceSchema,
    value,
    "source-control configuration resource",
  );
export const parseSourceControlInstallLinkResource = (value: unknown) =>
  parse<SourceControlInstallLinkResource>(
    SourceControlInstallLinkResourceSchema,
    value,
    "source-control install link resource",
  );
export const parseSourceControlIssueJobListResource = (value: unknown) =>
  parse<SourceControlIssueJobListResource>(
    SourceControlIssueJobListResourceSchema,
    value,
    "source-control issue-job-list resource",
  );
export const parseSourceControlIssueJobResource = (value: unknown) =>
  parse<SourceControlIssueJobResource>(
    SourceControlIssueJobResourceSchema,
    value,
    "source-control Issue Job resource",
  );
export const parseSourceControlIssueGitCredentialRequest = (value: unknown) =>
  parse<SourceControlIssueGitCredentialRequest>(
    SourceControlIssueGitCredentialRequestSchema,
    value,
    "source-control Issue Git credential request",
  );
export const parseSourceControlIssueGitCredentialResource = (value: unknown) =>
  parse<SourceControlIssueGitCredentialResource>(
    SourceControlIssueGitCredentialResourceSchema,
    value,
    "source-control Issue Git credential resource",
  );
export const parseSourceControlIssueGitAuthorizationLinkResource = (value: unknown) =>
  parse<SourceControlIssueGitAuthorizationLinkResource>(
    SourceControlIssueGitAuthorizationLinkResourceSchema,
    value,
    "source-control Issue Git authorization link resource",
  );
export const parseStartSourceControlIssueJobRequest = (
  value: unknown,
): StartSourceControlIssueJobRequest => {
  const request = parse<StartSourceControlIssueJobRequest>(
    StartSourceControlIssueJobRequestSchema,
    value,
    "start source-control Issue Job request",
  );
  const sessionTitle = request.sessionTitle.trim();
  if (sessionTitle.length === 0) {
    throw new SourceControlProtocolError(
      "start source-control Issue Job request failed validation at /sessionTitle",
    );
  }
  return { ...request, sessionTitle };
};
export const parseConnectGitLabProjectRequest = (value: unknown) =>
  parse<ConnectGitLabProjectRequest>(
    ConnectGitLabProjectRequestSchema,
    value,
    "connect GitLab project request",
  );
export const parseSourceControlWorkspaceCredentialRequest = (value: unknown) => {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "source_control.workspace_credential_authorize"
  ) {
    return parse<SourceControlWorkspaceCredentialAuthorizeRequest>(
      SourceControlWorkspaceCredentialAuthorizeRequestSchema,
      value,
      "source-control Workspace credential authorization request",
    );
  }
  return parse<SourceControlWorkspaceCredentialPreflightRequest>(
    SourceControlWorkspaceCredentialPreflightRequestSchema,
    value,
    "source-control Workspace credential preflight request",
  );
};
export const parseSourceControlWorkspaceCredentialResponse = (value: unknown) =>
  parse<SourceControlWorkspaceCredentialResponse>(
    SourceControlWorkspaceCredentialResponseSchema,
    value,
    "source-control Workspace credential response",
  );
