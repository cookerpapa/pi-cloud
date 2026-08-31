import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  NonNegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
  ExecutionModeSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./protocol-primitives.ts";
import {
  PiCloudEventSchema,
  SessionStateSchema,
  TurnCancellationReasonSchema,
} from "./event-envelope.ts";
import {
  EnvironmentRuntimeSnapshotSchema,
  ProjectEnvironmentResourceSchema,
} from "./environment.ts";
import { DevelopmentEnvironmentProfileKeySchema } from "./development-environment-profile.ts";

export const TurnThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

export const IdempotencyKeySchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

export const TenantApiRoleSchema = Type.Union([
  Type.Literal("owner"),
  Type.Literal("member"),
  Type.Literal("viewer"),
]);

export const DeepSeekModelIdSchema = Type.Union([
  Type.Literal("deepseek-v4-flash"),
  Type.Literal("deepseek-v4-pro"),
]);

export const OpenAICodexModelIdSchema = Type.Union([
  Type.Literal("gpt-5.6-luna"),
  Type.Literal("gpt-5.6-terra"),
  Type.Literal("gpt-5.6-sol"),
]);

export const ProviderModelSelectionSchema = Type.Union([
  Type.Object(
    { provider: Type.Literal("deepseek"), modelId: DeepSeekModelIdSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { provider: Type.Literal("openai-codex"), modelId: OpenAICodexModelIdSchema },
    { additionalProperties: false },
  ),
]);

export const ReplaceModelConfigurationRequestSchema = ProviderModelSelectionSchema;

export const ModelCatalogEntryResourceSchema = Type.Union([
  Type.Object(
    {
      provider: Type.Literal("deepseek"),
      modelId: DeepSeekModelIdSchema,
      displayName: Type.String({ minLength: 1, maxLength: 128 }),
      default: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      provider: Type.Literal("openai-codex"),
      modelId: OpenAICodexModelIdSchema,
      displayName: Type.String({ minLength: 1, maxLength: 128 }),
      default: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);

export const ModelCatalogResourceSchema = Type.Object(
  {
    models: Type.Array(ModelCatalogEntryResourceSchema, { minItems: 1, maxItems: 20 }),
  },
  { additionalProperties: false },
);

export const UpdateSessionModelRequestSchema = ProviderModelSelectionSchema;

export const SessionModelResourceSchema = Type.Union([
  Type.Object(
    {
      sessionId: UuidSchema,
      modelProfileId: UuidSchema,
      provider: Type.Literal("deepseek"),
      modelId: DeepSeekModelIdSchema,
      displayName: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      sessionId: UuidSchema,
      modelProfileId: UuidSchema,
      provider: Type.Literal("openai-codex"),
      modelId: OpenAICodexModelIdSchema,
      displayName: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
]);

export const ModelConfigurationResourceSchema = Type.Union([
  Type.Object(
    {
      mode: Type.Literal("deterministic"),
      provider: Type.Literal("pi-cloud-fake"),
      modelId: Type.Literal("pi-cloud-fake"),
      configured: Type.Literal(false),
      routeVersion: PositiveSafeIntegerSchema,
      updatedAt: UtcTimestampSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      mode: Type.Literal("real"),
      provider: Type.Literal("deepseek"),
      modelId: DeepSeekModelIdSchema,
      configured: Type.Literal(true),
      routeVersion: PositiveSafeIntegerSchema,
      updatedAt: UtcTimestampSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      mode: Type.Literal("real"),
      provider: Type.Literal("openai-codex"),
      modelId: OpenAICodexModelIdSchema,
      configured: Type.Literal(true),
      routeVersion: PositiveSafeIntegerSchema,
      updatedAt: UtcTimestampSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ReplaceCubeProxyConfigurationRequestSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    proxyUrl: Type.Optional(
      Type.String({
        minLength: 9,
        maxLength: 2_048,
        pattern: "^https?://[^\\s\\u0000-\\u001f\\u007f]+$",
      }),
    ),
  },
  { additionalProperties: false },
);

export const CubeProxyConfigurationResourceSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    configured: Type.Boolean(),
    proxyUrl: Type.Optional(Type.String({ minLength: 9, maxLength: 2_048 })),
    revision: NonNegativeSafeIntegerSchema,
    updatedAt: Type.Optional(UtcTimestampSchema),
  },
  { additionalProperties: false },
);

export const InternalCubeProxyConfigurationResourceSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    upstreamProxyUrl: Type.Optional(Type.String({ minLength: 9, maxLength: 2_048 })),
    revision: NonNegativeSafeIntegerSchema,
  },
  { additionalProperties: false },
);

export const AccountUsernameSchema = Type.String({
  minLength: 3,
  maxLength: 48,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{2,47}$",
});

const IdentityUsernameSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$",
});

export const TenantIdentityResourceSchema = Type.Object(
  {
    tenantId: UuidSchema,
    tenantSlug: Type.String({ minLength: 1, maxLength: 256 }),
    userId: UuidSchema,
    username: Type.Optional(IdentityUsernameSchema),
    displayName: Type.String({ minLength: 1, maxLength: 256 }),
    role: TenantApiRoleSchema,
    authenticationKind: Type.Union([
      Type.Literal("local"),
      Type.Literal("api"),
      Type.Literal("system"),
    ]),
    platformAdministrator: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const AuthenticationConfigurationResourceSchema = Type.Object(
  {
    local: Type.Object(
      { login: Type.Boolean(), registration: Type.Boolean() },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const AccountPasswordSchema = Type.String({ minLength: 10, maxLength: 128 });

export const RegisterAccountRequestSchema = Type.Object(
  {
    username: AccountUsernameSchema,
    displayName: Type.String({ minLength: 1, maxLength: 256 }),
    password: AccountPasswordSchema,
  },
  { additionalProperties: false },
);

export const LoginAccountRequestSchema = Type.Object(
  {
    username: AccountUsernameSchema,
    password: AccountPasswordSchema,
  },
  { additionalProperties: false },
);

export const AuthSessionResourceSchema = Type.Object(
  {
    identity: TenantIdentityResourceSchema,
    expiresAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const LogoutResourceSchema = Type.Object(
  { loggedOut: Type.Literal(true) },
  { additionalProperties: false },
);

export const CreateTenantRegistrationRequestSchema = Type.Object(
  {
    tenantSlug: Type.String({ minLength: 1, maxLength: 128 }),
    displayName: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);

export const TenantRegistrationResourceSchema = Type.Object(
  {
    tenantId: UuidSchema,
    tenantSlug: Type.String({ minLength: 1, maxLength: 64 }),
    userId: UuidSchema,
    displayName: Type.String({ minLength: 1, maxLength: 256 }),
    role: Type.Literal("owner"),
    apiToken: Type.String({
      minLength: 84,
      maxLength: 297,
      pattern:
        "^pck_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\\.[A-Za-z0-9_-]{43,256}$",
    }),
  },
  { additionalProperties: false },
);

export const WorkspaceSourceRequestSchema = Type.Union([
  Type.Object({ kind: Type.Literal("empty") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("sample_java") }, { additionalProperties: false }),
]);

export const WorkspaceSourceResourceSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("empty"), status: Type.Literal("ready") },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("sample_java"), status: Type.Literal("ready") },
    { additionalProperties: false },
  ),
]);

export const CreateProjectRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 256 }),
    source: Type.Optional(WorkspaceSourceRequestSchema),
  },
  { additionalProperties: false },
);

export const ProjectResourceSchema = Type.Object(
  {
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    createdAt: UtcTimestampSchema,
    source: WorkspaceSourceResourceSchema,
    environment: ProjectEnvironmentResourceSchema,
  },
  { additionalProperties: false },
);

export const CreateSessionRequestSchema = Type.Object(
  {
    workspaceId: UuidSchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    model: Type.Optional(ProviderModelSelectionSchema),
    executionMode: Type.Optional(ExecutionModeSchema),
    sandboxProfileKey: Type.Optional(DevelopmentEnvironmentProfileKeySchema),
    workingDirectory: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4_096,
        pattern: "^/",
      }),
    ),
  },
  { additionalProperties: false },
);

export const ConversationWorkspaceStateSchema = Type.Union([
  Type.Literal("attached"),
  Type.Literal("missing"),
]);

export const SessionResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    developmentEnvironmentId: Type.Optional(UuidSchema),
    workspaceState: ConversationWorkspaceStateSchema,
    state: Type.Literal("cold"),
    executionMode: ExecutionModeSchema,
    sandboxProfileKey: DevelopmentEnvironmentProfileKeySchema,
    workingDirectory: Type.String({ minLength: 1, maxLength: 4_096, pattern: "^/" }),
    modelProfileId: UuidSchema,
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const ConversationTurnStateSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("cancelling"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

export const ConversationSummaryResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    developmentEnvironmentId: Type.Optional(UuidSchema),
    workspaceName: Type.String({ minLength: 1, maxLength: 256 }),
    workspaceState: ConversationWorkspaceStateSchema,
    state: SessionStateSchema,
    executionMode: ExecutionModeSchema,
    sandboxProfileKey: DevelopmentEnvironmentProfileKeySchema,
    workingDirectory: Type.String({ minLength: 1, maxLength: 4_096, pattern: "^/" }),
    turnCount: NonNegativeSafeIntegerSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    lastActiveAt: UtcTimestampSchema,
    parentSessionId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);

export const DelegatedSessionContextModeSchema = Type.Union([
  Type.Literal("fresh"),
  Type.Literal("fork"),
]);

export const DelegatedSessionWorkspaceModeSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("shared"),
  Type.Literal("isolated"),
]);

export const DelegatedSessionStateSchema = Type.Union([
  Type.Literal("preparing"),
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("unknown"),
]);

/**
 * A delegated Pi Session is visible product history, but it is not a normal
 * human conversation fork. The parent Turn is the causal/UI anchor while the
 * context and Workspace modes describe two independent inheritance axes.
 */
export const DelegatedSessionSummaryResourceSchema = Type.Object(
  {
    executionId: UuidSchema,
    sessionId: UuidSchema,
    parentSessionId: UuidSchema,
    rootSessionId: UuidSchema,
    parentExecutionId: Type.Optional(UuidSchema),
    depth: PositiveSafeIntegerSchema,
    parentTurnId: UuidSchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    agentName: Type.String({ minLength: 1, maxLength: 128 }),
    contextMode: DelegatedSessionContextModeSchema,
    workspaceMode: DelegatedSessionWorkspaceModeSchema,
    state: DelegatedSessionStateSchema,
    workspaceName: Type.String({ minLength: 1, maxLength: 256 }),
    createdAt: UtcTimestampSchema,
    settledAt: Type.Optional(UtcTimestampSchema),
  },
  { additionalProperties: false },
);

export const ConversationListResourceSchema = Type.Object(
  {
    conversations: Type.Array(ConversationSummaryResourceSchema, { maxItems: 100 }),
    delegatedSessions: Type.Array(DelegatedSessionSummaryResourceSchema, { maxItems: 500 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ConversationSessionResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    developmentEnvironmentId: Type.Optional(UuidSchema),
    workspaceState: ConversationWorkspaceStateSchema,
    state: SessionStateSchema,
    executionMode: ExecutionModeSchema,
    sandboxProfileKey: DevelopmentEnvironmentProfileKeySchema,
    workingDirectory: Type.String({ minLength: 1, maxLength: 4_096, pattern: "^/" }),
    modelProfileId: UuidSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    lastActiveAt: UtcTimestampSchema,
    parentSessionId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);

export const WorkspaceSummaryResourceSchema = Type.Object(
  {
    workspaceId: UuidSchema,
    projectId: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    sessionCount: NonNegativeSafeIntegerSchema,
    createdAt: UtcTimestampSchema,
    lastActiveAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const WorkspaceListResourceSchema = Type.Object(
  {
    workspaces: Type.Array(WorkspaceSummaryResourceSchema, { maxItems: 100 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const WorkspaceDeletionResourceSchema = Type.Object(
  {
    operationId: UuidSchema,
    workspaceId: UuidSchema,
    storageState: Type.Union([Type.Literal("pending"), Type.Literal("purged")]),
    detachedSessionCount: NonNegativeSafeIntegerSchema,
    replayed: Type.Boolean(),
    deletedAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const RebindConversationWorkspaceRequestSchema = Type.Object(
  { workspaceId: UuidSchema },
  { additionalProperties: false },
);

export const ConversationWorkspaceBindingResourceSchema = Type.Object(
  {
    operationId: UuidSchema,
    sessionId: UuidSchema,
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    workspaceName: Type.String({ minLength: 1, maxLength: 256 }),
    workspaceState: Type.Literal("attached"),
    replayed: Type.Boolean(),
    boundAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const SshAccessTicketResourceSchema = Type.Object(
  {
    ticketId: UuidSchema,
    sessionId: UuidSchema,
    environmentId: UuidSchema,
    host: Type.String({ minLength: 1, maxLength: 253 }),
    port: Type.Integer({ minimum: 1, maximum: 65_535 }),
    username: Type.Literal("picloud"),
    password: Type.String({ minLength: 64, maxLength: 256 }),
    command: Type.String({ minLength: 16, maxLength: 1_024 }),
    oneLineCommand: Type.String({ minLength: 64, maxLength: 2_048 }),
    expiresAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const DevelopmentEnvironmentStateSchema = Type.Union([
  Type.Literal("requested"),
  Type.Literal("provisioning"),
  Type.Literal("running"),
  Type.Literal("paused"),
  Type.Literal("releasing"),
  Type.Literal("released"),
  Type.Literal("failed"),
  Type.Literal("unknown"),
]);

export const DevelopmentEnvironmentActionSchema = Type.Union([
  Type.Literal("pause"),
  Type.Literal("resume"),
  Type.Literal("release"),
]);

export const CreateDevelopmentEnvironmentRequestSchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^(?!\\s)(?!.*\\s$)[^\\u0000-\\u001f\\u007f]+$",
    }),
    profileKey: DevelopmentEnvironmentProfileKeySchema,
  },
  { additionalProperties: false },
);

export const DevelopmentEnvironmentActionRequestSchema = Type.Object(
  { action: DevelopmentEnvironmentActionSchema },
  { additionalProperties: false },
);

export const DevelopmentEnvironmentResourceSchema = Type.Object(
  {
    environmentId: UuidSchema,
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    workspaceName: Type.String({ minLength: 1, maxLength: 256 }),
    state: DevelopmentEnvironmentStateSchema,
    generation: PositiveSafeIntegerSchema,
    profileKey: DevelopmentEnvironmentProfileKeySchema,
    cpuCount: PositiveSafeIntegerSchema,
    memoryMiB: PositiveSafeIntegerSchema,
    systemDiskGiB: PositiveSafeIntegerSchema,
    ipAddress: Type.Optional(Type.String({ minLength: 7, maxLength: 45 })),
    failureCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    releasedAt: Type.Optional(UtcTimestampSchema),
  },
  { additionalProperties: false },
);

export const DevelopmentEnvironmentListResourceSchema = Type.Object(
  {
    environments: Type.Array(DevelopmentEnvironmentResourceSchema, { maxItems: 100 }),
    profiles: Type.Array(
      Type.Object(
        {
          key: DevelopmentEnvironmentProfileKeySchema,
          label: Type.String({ minLength: 1, maxLength: 64 }),
          cpuCount: PositiveSafeIntegerSchema,
          memoryMiB: PositiveSafeIntegerSchema,
          systemDiskGiB: PositiveSafeIntegerSchema,
          recommended: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 8 },
    ),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ConversationTranscriptItemResourceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("text"),
      text: Type.String(),
      firstSequence: PositiveSafeIntegerSchema,
      lastSequence: PositiveSafeIntegerSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("tool"),
      toolCallId: Type.String({ minLength: 1, maxLength: 1_024 }),
      toolName: Type.String({ minLength: 1, maxLength: 1_024 }),
      input: Type.Unknown(),
      output: Type.Optional(Type.Unknown()),
      status: Type.Union([
        Type.Literal("running"),
        Type.Literal("completed"),
        Type.Literal("failed"),
        Type.Literal("unknown"),
      ]),
      firstSequence: PositiveSafeIntegerSchema,
      lastSequence: Type.Optional(PositiveSafeIntegerSchema),
      startedAt: UtcTimestampSchema,
      completedAt: Type.Optional(UtcTimestampSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("notification"),
      level: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
      message: Type.String({ maxLength: 16_384 }),
      sequence: PositiveSafeIntegerSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("compaction"),
      reason: Type.Union([
        Type.Literal("manual"),
        Type.Literal("threshold"),
        Type.Literal("overflow"),
      ]),
      status: Type.Union([
        Type.Literal("running"),
        Type.Literal("completed"),
        Type.Literal("aborted"),
        Type.Literal("failed"),
      ]),
      willRetry: Type.Boolean(),
      tokensBefore: Type.Optional(Type.Integer({ minimum: 0 })),
      estimatedTokensAfter: Type.Optional(Type.Integer({ minimum: 0 })),
      firstSequence: PositiveSafeIntegerSchema,
      lastSequence: Type.Optional(PositiveSafeIntegerSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("retry"),
      nextSamplingAttempt: PositiveSafeIntegerSchema,
      maximumSamplingAttempts: Type.Optional(PositiveSafeIntegerSchema),
      delayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 300_000 })),
      sequence: PositiveSafeIntegerSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ConversationTurnTranscriptResourceSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    throughSequence: PositiveSafeIntegerSchema,
    items: Type.Array(ConversationTranscriptItemResourceSchema, { maxItems: 10_000 }),
    startedSequence: Type.Union([PositiveSafeIntegerSchema, Type.Null()]),
    terminalSequence: Type.Union([PositiveSafeIntegerSchema, Type.Null()]),
    stopReason: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
    failure: Type.Union([
      Type.Object(
        {
          code: Type.String({ minLength: 1, maxLength: 256 }),
          message: Type.String({ maxLength: 16_384 }),
          retryable: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    cancellation: Type.Union([
      Type.Object(
        {
          reason: TurnCancellationReasonSchema,
          forced: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export const ConversationTurnResourceSchema = Type.Object(
  {
    runId: UuidSchema,
    turnId: UuidSchema,
    mailboxPosition: PositiveSafeIntegerSchema,
    prompt: Type.String({ minLength: 1, maxLength: 100_000 }),
    state: ConversationTurnStateSchema,
    transcript: Type.Optional(ConversationTurnTranscriptResourceSchema),
    acceptedAt: UtcTimestampSchema,
    originSessionId: Type.Optional(UuidSchema),
    forkEntryId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);

export const ConversationDetailResourceSchema = Type.Object(
  {
    project: ProjectResourceSchema,
    session: ConversationSessionResourceSchema,
    inheritedMessages: Type.Array(
      Type.Object(
        {
          entryId: Type.String({ minLength: 1, maxLength: 512 }),
          role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
          text: Type.String({ maxLength: 100_000 }),
          createdAt: UtcTimestampSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 10_000 },
    ),
    turns: Type.Array(ConversationTurnResourceSchema, { maxItems: 200 }),
    historyTruncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const SessionViewSnapshotResourceSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    conversation: ConversationDetailResourceSchema,
    liveEvents: Type.Array(PiCloudEventSchema, { maxItems: 100_000 }),
  },
  { additionalProperties: false },
);

export const ConversationTreeViewSchema = Type.Union([Type.Literal("focus"), Type.Literal("full")]);

export const ConversationTreeEntryResourceSchema = Type.Object(
  {
    entryId: UuidSchema,
    parentEntryId: Type.Union([UuidSchema, Type.Null()]),
    turnId: UuidSchema,
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    text: Type.String({ maxLength: 100_000 }),
    finalAssistant: Type.Boolean(),
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const ConversationTreeBranchResourceSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("conversation"), Type.Literal("subagent")]),
    sessionId: UuidSchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    parentSessionId: Type.Union([UuidSchema, Type.Null()]),
    forkedFromTurnId: Type.Union([UuidSchema, Type.Null()]),
    forkedFromEntryId: Type.Union([UuidSchema, Type.Null()]),
    current: Type.Boolean(),
    agentName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    contextMode: Type.Optional(DelegatedSessionContextModeSchema),
    workspaceMode: Type.Optional(DelegatedSessionWorkspaceModeSchema),
    delegatedState: Type.Optional(DelegatedSessionStateSchema),
    entries: Type.Array(ConversationTreeEntryResourceSchema, { maxItems: 10_000 }),
  },
  { additionalProperties: false },
);

export const ConversationTreeResourceSchema = Type.Object(
  {
    rootSessionId: UuidSchema,
    currentSessionId: UuidSchema,
    view: ConversationTreeViewSchema,
    branches: Type.Array(ConversationTreeBranchResourceSchema, { maxItems: 100 }),
    delegatedSessions: Type.Array(DelegatedSessionSummaryResourceSchema, { maxItems: 500 }),
  },
  { additionalProperties: false },
);

export const CreateConversationForkRequestSchema = Type.Object(
  {
    turnId: UuidSchema,
    entryId: UuidSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);

export const ConversationForkResourceSchema = Type.Object(
  {
    session: SessionResourceSchema,
    parentSessionId: UuidSchema,
    forkedFromTurnId: UuidSchema,
    forkedFromEntryId: UuidSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CreateConversationPruneRequestSchema = Type.Object(
  {
    turnId: UuidSchema,
    entryId: UuidSchema,
  },
  { additionalProperties: false },
);

export const ConversationPruneResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    anchorTurnId: UuidSchema,
    anchorEntryId: UuidSchema,
    prunedTurnCount: NonNegativeSafeIntegerSchema,
    archivedSessionCount: NonNegativeSafeIntegerSchema,
    replayed: Type.Boolean(),
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const AcceptTurnRequestSchema = Type.Object(
  {
    prompt: Type.String({ minLength: 1, maxLength: 100_000 }),
    thinkingLevel: Type.Optional(TurnThinkingLevelSchema),
  },
  { additionalProperties: false },
);

export const AcceptedTurnResourceSchema = Type.Object(
  {
    runId: UuidSchema,
    turnId: UuidSchema,
    sessionId: UuidSchema,
    mailboxPosition: PositiveSafeIntegerSchema,
    state: Type.Literal("queued"),
    acceptedAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const RunStateSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("claimed"),
  Type.Literal("provisioning"),
  Type.Literal("restoring"),
  Type.Literal("running"),
  Type.Literal("settling"),
  Type.Literal("cancel_requested"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
  Type.Literal("superseded"),
]);

export const RunAttemptStateSchema = Type.Union([
  Type.Literal("claimed"),
  Type.Literal("provisioning"),
  Type.Literal("restoring"),
  Type.Literal("running"),
  Type.Literal("settling"),
  Type.Literal("cancel_requested"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
  Type.Literal("superseded"),
]);

const RunFailureResourceSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 128 }),
    message: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const RunAttemptTransitionResourceSchema = Type.Object(
  {
    fromState: Type.Union([RunAttemptStateSchema, Type.Null()]),
    toState: RunAttemptStateSchema,
    reason: Type.String({ minLength: 1, maxLength: 256 }),
    occurredAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const RunAttemptResourceSchema = Type.Object(
  {
    attemptId: UuidSchema,
    attemptNumber: PositiveSafeIntegerSchema,
    state: RunAttemptStateSchema,
    projection: Type.Union([Type.Literal("canonical"), Type.Literal("superseded")]),
    supersededByAttemptId: Type.Optional(UuidSchema),
    claimOwnerId: Type.String({ minLength: 1, maxLength: 256 }),
    claimExpiresAt: UtcTimestampSchema,
    sandboxId: Type.Optional(UuidSchema),
    settlementRevision: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
    failure: Type.Optional(RunFailureResourceSchema),
    claimedAt: UtcTimestampSchema,
    provisioningAt: Type.Optional(UtcTimestampSchema),
    restoringAt: Type.Optional(UtcTimestampSchema),
    runningAt: Type.Optional(UtcTimestampSchema),
    settlingAt: Type.Optional(UtcTimestampSchema),
    lastHeartbeatAt: Type.Optional(UtcTimestampSchema),
    settledAt: Type.Optional(UtcTimestampSchema),
    transitions: Type.Array(RunAttemptTransitionResourceSchema, { maxItems: 128 }),
  },
  { additionalProperties: false },
);

export const RunResourceSchema = Type.Object(
  {
    runId: UuidSchema,
    traceId: Type.String({ pattern: "^[0-9a-f]{32}$" }),
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    sessionId: UuidSchema,
    turnId: UuidSchema,
    environment: EnvironmentRuntimeSnapshotSchema,
    state: RunStateSchema,
    attemptCount: NonNegativeSafeIntegerSchema,
    currentAttemptId: Type.Optional(UuidSchema),
    stopReason: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    failure: Type.Optional(RunFailureResourceSchema),
    queuedAt: UtcTimestampSchema,
    startedAt: Type.Optional(UtcTimestampSchema),
    settledAt: Type.Optional(UtcTimestampSchema),
    updatedAt: UtcTimestampSchema,
    attempts: Type.Array(RunAttemptResourceSchema, { maxItems: 32 }),
  },
  { additionalProperties: false },
);

export const WorkspaceDirectoryEntryResourceSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 255 }),
    path: Type.String({ minLength: 1, maxLength: 512 }),
    kind: Type.Union([Type.Literal("directory"), Type.Literal("file"), Type.Literal("symlink")]),
    sizeBytes: Type.Optional(NonNegativeSafeIntegerSchema),
    executable: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const WorkspaceDirectoryResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    workspaceId: UuidSchema,
    path: Type.String({ minLength: 0, maxLength: 512 }),
    entries: Type.Array(WorkspaceDirectoryEntryResourceSchema, { maxItems: 4_096 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const WorkspaceOperationResourceSchema = Type.Object(
  {
    operationId: UuidSchema,
    kind: Type.Union([Type.Literal("archive"), Type.Literal("unarchive")]),
    sessionId: UuidSchema,
    settlementId: Type.Optional(UuidSchema),
    replayed: Type.Boolean(),
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const CreateTurnCancellationRequestSchema = Type.Object(
  {
    gracePeriodMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 })),
  },
  { additionalProperties: false },
);

export const AcceptedTurnCancellationResourceSchema = Type.Object(
  {
    controlRequestId: UuidSchema,
    targetRunId: UuidSchema,
    turnId: UuidSchema,
    sessionId: UuidSchema,
    state: Type.Literal("pending"),
    acceptedAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CreateTurnSteerRequestSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 100_000 }),
  },
  { additionalProperties: false },
);

export const TurnSteerResourceSchema = Type.Object(
  {
    controlRequestId: UuidSchema,
    targetRunId: UuidSchema,
    turnId: UuidSchema,
    sessionId: UuidSchema,
    state: Type.Literal("delivered"),
    acceptedAt: UtcTimestampSchema,
    deliveredAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ControlPlaneApiErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String({ minLength: 1, maxLength: 128 }),
        message: Type.String({ minLength: 1, maxLength: 1_024 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type TurnThinkingLevel = Static<typeof TurnThinkingLevelSchema>;
export type TenantApiRole = Static<typeof TenantApiRoleSchema>;
export type TenantIdentityResource = Static<typeof TenantIdentityResourceSchema>;
export type AuthenticationConfigurationResource = Static<
  typeof AuthenticationConfigurationResourceSchema
>;
export type RegisterAccountRequest = Static<typeof RegisterAccountRequestSchema>;
export type LoginAccountRequest = Static<typeof LoginAccountRequestSchema>;
export type AuthSessionResource = Static<typeof AuthSessionResourceSchema>;
export type LogoutResource = Static<typeof LogoutResourceSchema>;
export type DeepSeekModelId = Static<typeof DeepSeekModelIdSchema>;
export type OpenAICodexModelId = Static<typeof OpenAICodexModelIdSchema>;
export type ProviderModelSelection = Static<typeof ProviderModelSelectionSchema>;
export type ModelCatalogEntryResource = Static<typeof ModelCatalogEntryResourceSchema>;
export type ModelCatalogResource = Static<typeof ModelCatalogResourceSchema>;
export type UpdateSessionModelRequest = Static<typeof UpdateSessionModelRequestSchema>;
export type SessionModelResource = Static<typeof SessionModelResourceSchema>;
export type ReplaceModelConfigurationRequest = Static<
  typeof ReplaceModelConfigurationRequestSchema
>;
export type ModelConfigurationResource = Static<typeof ModelConfigurationResourceSchema>;
export type ReplaceCubeProxyConfigurationRequest = Static<
  typeof ReplaceCubeProxyConfigurationRequestSchema
>;
export type CubeProxyConfigurationResource = Static<typeof CubeProxyConfigurationResourceSchema>;
export type InternalCubeProxyConfigurationResource = Static<
  typeof InternalCubeProxyConfigurationResourceSchema
>;
export type CreateTenantRegistrationRequest = Static<typeof CreateTenantRegistrationRequestSchema>;
export type TenantRegistrationResource = Static<typeof TenantRegistrationResourceSchema>;
export type WorkspaceSourceRequest = Static<typeof WorkspaceSourceRequestSchema>;
export type WorkspaceSourceResource = Static<typeof WorkspaceSourceResourceSchema>;
export type CreateProjectRequest = Static<typeof CreateProjectRequestSchema>;
export type ProjectResource = Static<typeof ProjectResourceSchema>;
export type { ExecutionMode } from "./protocol-primitives.ts";
export type CreateSessionRequest = Static<typeof CreateSessionRequestSchema>;
export type SessionResource = Static<typeof SessionResourceSchema>;
export type WorkspaceSummaryResource = Static<typeof WorkspaceSummaryResourceSchema>;
export type WorkspaceListResource = Static<typeof WorkspaceListResourceSchema>;
export type WorkspaceDeletionResource = Static<typeof WorkspaceDeletionResourceSchema>;
export type ConversationWorkspaceState = Static<typeof ConversationWorkspaceStateSchema>;
export type RebindConversationWorkspaceRequest = Static<
  typeof RebindConversationWorkspaceRequestSchema
>;
export type ConversationWorkspaceBindingResource = Static<
  typeof ConversationWorkspaceBindingResourceSchema
>;
export type SshAccessTicketResource = Static<typeof SshAccessTicketResourceSchema>;
export type DevelopmentEnvironmentState = Static<typeof DevelopmentEnvironmentStateSchema>;
export type DevelopmentEnvironmentProfileKey = Static<
  typeof DevelopmentEnvironmentProfileKeySchema
>;
export type DevelopmentEnvironmentAction = Static<typeof DevelopmentEnvironmentActionSchema>;
export type CreateDevelopmentEnvironmentRequest = Static<
  typeof CreateDevelopmentEnvironmentRequestSchema
>;
export type DevelopmentEnvironmentActionRequest = Static<
  typeof DevelopmentEnvironmentActionRequestSchema
>;
export type DevelopmentEnvironmentResource = Static<typeof DevelopmentEnvironmentResourceSchema>;
export type DevelopmentEnvironmentListResource = Static<
  typeof DevelopmentEnvironmentListResourceSchema
>;
export type ConversationTurnState = Static<typeof ConversationTurnStateSchema>;
export type ConversationSummaryResource = Static<typeof ConversationSummaryResourceSchema>;
export type DelegatedSessionContextMode = Static<typeof DelegatedSessionContextModeSchema>;
export type DelegatedSessionWorkspaceMode = Static<typeof DelegatedSessionWorkspaceModeSchema>;
export type DelegatedSessionState = Static<typeof DelegatedSessionStateSchema>;
export type DelegatedSessionSummaryResource = Static<typeof DelegatedSessionSummaryResourceSchema>;
export type ConversationListResource = Static<typeof ConversationListResourceSchema>;
export type ConversationSessionResource = Static<typeof ConversationSessionResourceSchema>;
export type ConversationTranscriptItemResource = Static<
  typeof ConversationTranscriptItemResourceSchema
>;
export type ConversationTurnTranscriptResource = Static<
  typeof ConversationTurnTranscriptResourceSchema
>;
export type ConversationTurnResource = Static<typeof ConversationTurnResourceSchema>;
export type ConversationDetailResource = Static<typeof ConversationDetailResourceSchema>;
export type SessionViewSnapshotResource = Static<typeof SessionViewSnapshotResourceSchema>;
export type ConversationTreeView = Static<typeof ConversationTreeViewSchema>;
export type ConversationTreeEntryResource = Static<typeof ConversationTreeEntryResourceSchema>;
export type ConversationTreeBranchResource = Static<typeof ConversationTreeBranchResourceSchema>;
export type ConversationTreeResource = Static<typeof ConversationTreeResourceSchema>;
export type CreateConversationForkRequest = Static<typeof CreateConversationForkRequestSchema>;
export type ConversationForkResource = Static<typeof ConversationForkResourceSchema>;
export type CreateConversationPruneRequest = Static<typeof CreateConversationPruneRequestSchema>;
export type ConversationPruneResource = Static<typeof ConversationPruneResourceSchema>;
export type AcceptTurnRequest = Static<typeof AcceptTurnRequestSchema>;
export type AcceptedTurnResource = Static<typeof AcceptedTurnResourceSchema>;
export type RunState = Static<typeof RunStateSchema>;
export type RunAttemptState = Static<typeof RunAttemptStateSchema>;
export type RunAttemptTransitionResource = Static<typeof RunAttemptTransitionResourceSchema>;
export type RunAttemptResource = Static<typeof RunAttemptResourceSchema>;
export type RunResource = Static<typeof RunResourceSchema>;
export type WorkspaceDirectoryEntryResource = Static<typeof WorkspaceDirectoryEntryResourceSchema>;
export type WorkspaceDirectoryResource = Static<typeof WorkspaceDirectoryResourceSchema>;
export type WorkspaceOperationResource = Static<typeof WorkspaceOperationResourceSchema>;
export type CreateTurnCancellationRequest = Static<typeof CreateTurnCancellationRequestSchema>;
export type AcceptedTurnCancellationResource = Static<
  typeof AcceptedTurnCancellationResourceSchema
>;
export type CreateTurnSteerRequest = Static<typeof CreateTurnSteerRequestSchema>;
export type TurnSteerResource = Static<typeof TurnSteerResourceSchema>;
export type ControlPlaneApiError = Static<typeof ControlPlaneApiErrorSchema>;

export class ControlPlaneApiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneApiValidationError";
  }
}

function parseSchema<Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  description: string,
): Static<Schema> {
  if (!Value.Check(schema, value)) {
    const issue = [...Value.Errors(schema, value)][0];
    const location = issue?.instancePath.length ? issue.instancePath : "/";
    throw new ControlPlaneApiValidationError(
      `Invalid ${description} at ${location}: ${issue?.message ?? "schema validation failed"}`,
    );
  }
  return value as Static<Schema>;
}

export function parseCreateProjectRequest(value: unknown): CreateProjectRequest {
  const request = parseSchema(CreateProjectRequestSchema, value, "create-project request");
  const name = request.name.trim();
  if (name.length === 0) {
    throw new ControlPlaneApiValidationError(
      "Project name must contain a non-whitespace character",
    );
  }
  return { name, source: request.source ?? { kind: "empty" } };
}

export function parseTenantIdentityResource(value: unknown): TenantIdentityResource {
  return parseSchema(TenantIdentityResourceSchema, value, "tenant identity resource");
}

export function parseAuthenticationConfigurationResource(
  value: unknown,
): AuthenticationConfigurationResource {
  return parseSchema(
    AuthenticationConfigurationResourceSchema,
    value,
    "authentication configuration resource",
  );
}

function normalizedAccountPassword(value: string): string {
  const byteLength = new TextEncoder().encode(value).length;
  if (byteLength < 10 || byteLength > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ControlPlaneApiValidationError(
      "Password must contain 10-128 characters and at most 256 safe UTF-8 bytes",
    );
  }
  return value;
}

export function parseRegisterAccountRequest(value: unknown): RegisterAccountRequest {
  const request = parseSchema(RegisterAccountRequestSchema, value, "account registration request");
  const username = request.username.trim().toLowerCase();
  const displayName = request.displayName.trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,47}$/.test(username)) {
    throw new ControlPlaneApiValidationError(
      "Username must contain 3-48 lowercase letters, digits, dots, underscores, or hyphens",
    );
  }
  if (
    displayName.length === 0 ||
    new TextEncoder().encode(displayName).length > 256 ||
    /[\u0000-\u001f\u007f]/.test(displayName)
  ) {
    throw new ControlPlaneApiValidationError("Display name must contain 1-256 safe UTF-8 bytes");
  }
  return { username, displayName, password: normalizedAccountPassword(request.password) };
}

export function parseLoginAccountRequest(value: unknown): LoginAccountRequest {
  const request = parseSchema(LoginAccountRequestSchema, value, "account login request");
  return {
    username: request.username.trim().toLowerCase(),
    password: normalizedAccountPassword(request.password),
  };
}

export function parseAuthSessionResource(value: unknown): AuthSessionResource {
  return parseSchema(AuthSessionResourceSchema, value, "authenticated web session resource");
}

export function parseLogoutResource(value: unknown): LogoutResource {
  return parseSchema(LogoutResourceSchema, value, "logout resource");
}

export function parseReplaceModelConfigurationRequest(
  value: unknown,
): ReplaceModelConfigurationRequest {
  return parseSchema(
    ReplaceModelConfigurationRequestSchema,
    value,
    "replace-model-configuration request",
  );
}

export function parseModelConfigurationResource(value: unknown): ModelConfigurationResource {
  return parseSchema(ModelConfigurationResourceSchema, value, "model configuration resource");
}

export function parseModelCatalogResource(value: unknown): ModelCatalogResource {
  return parseSchema(ModelCatalogResourceSchema, value, "model catalog resource");
}

export function parseUpdateSessionModelRequest(value: unknown): UpdateSessionModelRequest {
  return parseSchema(UpdateSessionModelRequestSchema, value, "update-session-model request");
}

export function parseSessionModelResource(value: unknown): SessionModelResource {
  return parseSchema(SessionModelResourceSchema, value, "session model resource");
}

export function parseReplaceCubeProxyConfigurationRequest(
  value: unknown,
): ReplaceCubeProxyConfigurationRequest {
  return parseSchema(
    ReplaceCubeProxyConfigurationRequestSchema,
    value,
    "replace Cube proxy configuration request",
  );
}

export function parseCubeProxyConfigurationResource(
  value: unknown,
): CubeProxyConfigurationResource {
  return parseSchema(
    CubeProxyConfigurationResourceSchema,
    value,
    "Cube proxy configuration resource",
  );
}

export function parseInternalCubeProxyConfigurationResource(
  value: unknown,
): InternalCubeProxyConfigurationResource {
  return parseSchema(
    InternalCubeProxyConfigurationResourceSchema,
    value,
    "internal Cube proxy configuration resource",
  );
}

export function parseCreateTenantRegistrationRequest(
  value: unknown,
): CreateTenantRegistrationRequest {
  const request = parseSchema(
    CreateTenantRegistrationRequestSchema,
    value,
    "tenant registration request",
  );
  const tenantSlug = request.tenantSlug.trim().toLowerCase();
  const displayName = request.displayName.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(tenantSlug)) {
    throw new ControlPlaneApiValidationError(
      "Tenant slug must contain 1-64 lowercase letters, digits, or hyphens",
    );
  }
  if (
    displayName.length === 0 ||
    new TextEncoder().encode(displayName).length > 256 ||
    /[\u0000-\u001f\u007f]/.test(displayName)
  ) {
    throw new ControlPlaneApiValidationError("Display name must contain 1-256 safe UTF-8 bytes");
  }
  return { tenantSlug, displayName };
}

export function parseTenantRegistrationResource(value: unknown): TenantRegistrationResource {
  return parseSchema(TenantRegistrationResourceSchema, value, "tenant registration resource");
}

export function parseCreateSessionRequest(
  value: unknown,
): CreateSessionRequest & { executionMode: Static<typeof ExecutionModeSchema> } {
  const request = parseSchema(CreateSessionRequestSchema, value, "create-session request");
  const title = request.title.trim();
  if (
    title.length === 0 ||
    new TextEncoder().encode(title).length > 256 ||
    /[\u0000-\u001f\u007f]/.test(title)
  ) {
    throw new ControlPlaneApiValidationError(
      "Conversation title must contain 1-256 safe UTF-8 bytes",
    );
  }
  return { ...request, title, executionMode: request.executionMode ?? "elastic" };
}

export function parseAcceptTurnRequest(value: unknown): AcceptTurnRequest {
  const request = parseSchema(AcceptTurnRequestSchema, value, "accept-turn request");
  if (request.prompt.trim().length === 0) {
    throw new ControlPlaneApiValidationError("Turn prompt must contain a non-whitespace character");
  }
  return request;
}

export function parseCreateTurnCancellationRequest(value: unknown): CreateTurnCancellationRequest {
  return parseSchema(
    CreateTurnCancellationRequestSchema,
    value,
    "create-turn-cancellation request",
  );
}

export function parseCreateTurnSteerRequest(value: unknown): CreateTurnSteerRequest {
  const request = parseSchema(CreateTurnSteerRequestSchema, value, "create-turn-steer request");
  if (request.text.trim().length === 0) {
    throw new ControlPlaneApiValidationError("Steer text must contain a non-whitespace character");
  }
  return request;
}

export function parseProjectResource(value: unknown): ProjectResource {
  return parseSchema(ProjectResourceSchema, value, "project resource");
}

export function parseSessionResource(value: unknown): SessionResource {
  return parseSchema(SessionResourceSchema, value, "session resource");
}

export function parseWorkspaceListResource(value: unknown): WorkspaceListResource {
  return parseSchema(WorkspaceListResourceSchema, value, "workspace list resource");
}

export function parseWorkspaceDeletionResource(value: unknown): WorkspaceDeletionResource {
  return parseSchema(WorkspaceDeletionResourceSchema, value, "workspace deletion resource");
}

export function parseRebindConversationWorkspaceRequest(
  value: unknown,
): RebindConversationWorkspaceRequest {
  return parseSchema(
    RebindConversationWorkspaceRequestSchema,
    value,
    "conversation Workspace rebind request",
  );
}

export function parseConversationWorkspaceBindingResource(
  value: unknown,
): ConversationWorkspaceBindingResource {
  return parseSchema(
    ConversationWorkspaceBindingResourceSchema,
    value,
    "conversation Workspace binding resource",
  );
}

export function parseSshAccessTicketResource(value: unknown): SshAccessTicketResource {
  return parseSchema(SshAccessTicketResourceSchema, value, "SSH access ticket resource");
}

export function parseCreateDevelopmentEnvironmentRequest(
  value: unknown,
): CreateDevelopmentEnvironmentRequest {
  return parseSchema(
    CreateDevelopmentEnvironmentRequestSchema,
    value,
    "create development environment request",
  );
}

export function parseDevelopmentEnvironmentActionRequest(
  value: unknown,
): DevelopmentEnvironmentActionRequest {
  return parseSchema(
    DevelopmentEnvironmentActionRequestSchema,
    value,
    "development environment action request",
  );
}

export function parseDevelopmentEnvironmentResource(
  value: unknown,
): DevelopmentEnvironmentResource {
  return parseSchema(
    DevelopmentEnvironmentResourceSchema,
    value,
    "development environment resource",
  );
}

export function parseDevelopmentEnvironmentListResource(
  value: unknown,
): DevelopmentEnvironmentListResource {
  return parseSchema(
    DevelopmentEnvironmentListResourceSchema,
    value,
    "development environment list resource",
  );
}

export function parseConversationListResource(value: unknown): ConversationListResource {
  return parseSchema(ConversationListResourceSchema, value, "conversation list resource");
}

export function parseConversationDetailResource(value: unknown): ConversationDetailResource {
  return parseSchema(ConversationDetailResourceSchema, value, "conversation detail resource");
}

export function parseConversationTreeView(value: unknown): ConversationTreeView {
  return value === undefined
    ? "focus"
    : parseSchema(ConversationTreeViewSchema, value, "conversation tree view");
}

export function parseConversationTreeResource(value: unknown): ConversationTreeResource {
  return parseSchema(ConversationTreeResourceSchema, value, "conversation tree resource");
}

export function parseCreateConversationForkRequest(value: unknown): CreateConversationForkRequest {
  const request = parseSchema(
    CreateConversationForkRequestSchema,
    value,
    "create-conversation-fork request",
  );
  if (request.title === undefined) return request;
  const title = request.title.trim();
  if (
    title.length === 0 ||
    new TextEncoder().encode(title).length > 256 ||
    /[\u0000-\u001f\u007f]/.test(title)
  ) {
    throw new ControlPlaneApiValidationError("Fork title must contain 1-256 safe UTF-8 bytes");
  }
  return { ...request, title };
}

export function parseConversationForkResource(value: unknown): ConversationForkResource {
  return parseSchema(ConversationForkResourceSchema, value, "conversation fork resource");
}

export function parseCreateConversationPruneRequest(
  value: unknown,
): CreateConversationPruneRequest {
  return parseSchema(CreateConversationPruneRequestSchema, value, "conversation prune request");
}

export function parseConversationPruneResource(value: unknown): ConversationPruneResource {
  return parseSchema(ConversationPruneResourceSchema, value, "conversation prune resource");
}

export function parseSessionViewSnapshotResource(value: unknown): SessionViewSnapshotResource {
  return parseSchema(SessionViewSnapshotResourceSchema, value, "Session view snapshot resource");
}

export function parseConversationTurnTranscriptResource(
  value: unknown,
): ConversationTurnTranscriptResource {
  return parseSchema(
    ConversationTurnTranscriptResourceSchema,
    value,
    "conversation turn transcript resource",
  );
}

export function parseAcceptedTurnResource(value: unknown): AcceptedTurnResource {
  return parseSchema(AcceptedTurnResourceSchema, value, "accepted-turn resource");
}

export function parseRunResource(value: unknown): RunResource {
  return parseSchema(RunResourceSchema, value, "run resource");
}

export function parseWorkspaceDirectoryResource(value: unknown): WorkspaceDirectoryResource {
  return parseSchema(WorkspaceDirectoryResourceSchema, value, "Workspace directory resource");
}

export function parseWorkspaceOperationResource(value: unknown): WorkspaceOperationResource {
  return parseSchema(WorkspaceOperationResourceSchema, value, "workspace-operation resource");
}

export function parseAcceptedTurnCancellationResource(
  value: unknown,
): AcceptedTurnCancellationResource {
  return parseSchema(
    AcceptedTurnCancellationResourceSchema,
    value,
    "accepted-turn-cancellation resource",
  );
}

export function parseTurnSteerResource(value: unknown): TurnSteerResource {
  return parseSchema(TurnSteerResourceSchema, value, "turn-steer resource");
}

export function parseControlPlaneApiError(value: unknown): ControlPlaneApiError {
  return parseSchema(ControlPlaneApiErrorSchema, value, "control-plane API error");
}

export function parseIdempotencyKey(value: unknown): string {
  return parseSchema(IdempotencyKeySchema, value, "Idempotency-Key header");
}

export function parseUuidPathParameter(value: unknown, name: string): string {
  return parseSchema(UuidSchema, value, `${name} path parameter`);
}

export function parsePositiveIntegerPathParameter(value: unknown, name: string): number {
  const normalized = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  return parseSchema(PositiveSafeIntegerSchema, normalized, `${name} path parameter`);
}
