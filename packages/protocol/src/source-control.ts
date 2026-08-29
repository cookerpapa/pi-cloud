import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { OpaqueIdSchema, UtcTimestampSchema, UuidSchema } from "./protocol-primitives.ts";

const ProviderSchema = Type.Literal("github");
const GitHubInstallationIdSchema = Type.String({ pattern: "^[1-9][0-9]{0,30}$" });
const GitHubTokenSchema = Type.String({
  minLength: 16,
  maxLength: 4_096,
  pattern: "^[^\\r\\n\\u0000]+$",
});
const GitShaSchema = Type.String({ pattern: "^[0-9a-f]{40}$" });
const GitRefSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: "^[^\\u0000-\\u001f\\u007f ~^:?*\\[\\\\]+$",
});

export const SourceControlRepositoryResourceSchema = Type.Object(
  {
    repositoryId: UuidSchema,
    installationId: UuidSchema,
    provider: ProviderSchema,
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
      Type.Literal("received"),
      Type.Literal("provisioning"),
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("publishing"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
    sessionId: Type.Optional(UuidSchema),
    runId: Type.Optional(UuidSchema),
    pullRequestUrl: Type.Optional(Type.String({ minLength: 8, maxLength: 2_048 })),
    failure: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const SourceControlIssueJobListResourceSchema = Type.Object(
  { jobs: Type.Array(SourceControlIssueJobResourceSchema, { maxItems: 100 }) },
  { additionalProperties: false },
);

export const SourceControlWorkspaceCheckoutRequestSchema = Type.Object(
  {
    sourceControlProtocolVersion: Type.Literal(1),
    type: Type.Literal("source_control.workspace_checkout"),
    requestId: UuidSchema,
    tenantId: OpaqueIdSchema,
    workspaceId: UuidSchema,
    repositoryId: UuidSchema,
    providerInstallationId: GitHubInstallationIdSchema,
    providerRepositoryId: GitHubInstallationIdSchema,
    cloneUrl: Type.String({
      minLength: 20,
      maxLength: 2_048,
      pattern: "^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\\.git$",
    }),
    baseRef: GitRefSchema,
    branchName: GitRefSchema,
    accessToken: GitHubTokenSchema,
  },
  { additionalProperties: false },
);

export const SourceControlWorkspaceCheckoutResponseSchema = Type.Object(
  {
    sourceControlProtocolVersion: Type.Literal(1),
    type: Type.Literal("source_control.workspace_checked_out"),
    requestId: UuidSchema,
    workspaceId: UuidSchema,
    repositoryId: UuidSchema,
    baseSha: GitShaSchema,
  },
  { additionalProperties: false },
);

export const SourceControlWorkspacePublishRequestSchema = Type.Object(
  {
    sourceControlProtocolVersion: Type.Literal(1),
    type: Type.Literal("source_control.workspace_publish"),
    requestId: UuidSchema,
    tenantId: OpaqueIdSchema,
    workspaceId: UuidSchema,
    repositoryId: UuidSchema,
    providerInstallationId: GitHubInstallationIdSchema,
    providerRepositoryId: GitHubInstallationIdSchema,
    cloneUrl: Type.String({
      minLength: 20,
      maxLength: 2_048,
      pattern: "^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\\.git$",
    }),
    baseRef: GitRefSchema,
    branchName: GitRefSchema,
    commitMessage: Type.String({ minLength: 1, maxLength: 1_024 }),
    authorName: Type.String({ minLength: 1, maxLength: 128 }),
    authorEmail: Type.String({ minLength: 3, maxLength: 254, pattern: "^[^@\\s]+@[^@\\s]+$" }),
    accessToken: GitHubTokenSchema,
  },
  { additionalProperties: false },
);

export const SourceControlWorkspacePublishResponseSchema = Type.Object(
  {
    sourceControlProtocolVersion: Type.Literal(1),
    type: Type.Literal("source_control.workspace_published"),
    requestId: UuidSchema,
    workspaceId: UuidSchema,
    repositoryId: UuidSchema,
    changed: Type.Boolean(),
    commitSha: Type.Optional(GitShaSchema),
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
export type SourceControlIssueJobListResource = Static<
  typeof SourceControlIssueJobListResourceSchema
>;
export type SourceControlWorkspaceCheckoutRequest = Static<
  typeof SourceControlWorkspaceCheckoutRequestSchema
>;
export type SourceControlWorkspaceCheckoutResponse = Static<
  typeof SourceControlWorkspaceCheckoutResponseSchema
>;
export type SourceControlWorkspacePublishRequest = Static<
  typeof SourceControlWorkspacePublishRequestSchema
>;
export type SourceControlWorkspacePublishResponse = Static<
  typeof SourceControlWorkspacePublishResponseSchema
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
export const parseSourceControlWorkspaceCheckoutRequest = (value: unknown) =>
  parse<SourceControlWorkspaceCheckoutRequest>(
    SourceControlWorkspaceCheckoutRequestSchema,
    value,
    "source-control checkout request",
  );
export const parseSourceControlWorkspaceCheckoutResponse = (value: unknown) =>
  parse<SourceControlWorkspaceCheckoutResponse>(
    SourceControlWorkspaceCheckoutResponseSchema,
    value,
    "source-control checkout response",
  );
export const parseSourceControlWorkspacePublishRequest = (value: unknown) =>
  parse<SourceControlWorkspacePublishRequest>(
    SourceControlWorkspacePublishRequestSchema,
    value,
    "source-control publish request",
  );
export const parseSourceControlWorkspacePublishResponse = (value: unknown) =>
  parse<SourceControlWorkspacePublishResponse>(
    SourceControlWorkspacePublishResponseSchema,
    value,
    "source-control publish response",
  );
