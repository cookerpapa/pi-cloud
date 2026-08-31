import { describe, expect, it } from "vitest";
import {
  ControlPlaneApiValidationError,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  parseAcceptTurnRequest,
  parseAcceptedTurnCancellationResource,
  parseAcceptedTurnResource,
  parseConversationDetailResource,
  parseConversationListResource,
  parseControlPlaneApiError,
  parseCreateProjectRequest,
  parseCreateSessionRequest,
  parseCreateTenantRegistrationRequest,
  parseCreateDevelopmentEnvironmentRequest,
  parseDevelopmentEnvironmentActionRequest,
  parseDevelopmentEnvironmentListResource,
  parseCreateTurnCancellationRequest,
  parseIdempotencyKey,
  parseModelConfigurationResource,
  parseModelCatalogResource,
  parseSessionModelResource,
  parseUpdateSessionModelRequest,
  parseProjectResource,
  parseReplaceModelConfigurationRequest,
  parseRunResource,
  parseSessionResource,
  parseTenantIdentityResource,
  parseTenantRegistrationResource,
  parseUuidPathParameter,
} from "../src/index.ts";

const UUID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_SNAPSHOT = {
  environmentVersionId: "90000000-0000-4000-8000-000000000001",
  versionNumber: 1,
  profileKey: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  profileVersion: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  imageRevision: "sha-0123456789abcdef",
  specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} as const;

describe("control-plane public API schemas", () => {
  it("validates user-owned development environment resources and actions", () => {
    const createdAt = "2026-08-20T00:00:00.000Z";
    expect(
      parseCreateDevelopmentEnvironmentRequest({ name: "Backend machine", profileKey: "standard" }),
    ).toEqual({
      name: "Backend machine",
      profileKey: "standard",
    });
    expect(parseDevelopmentEnvironmentActionRequest({ action: "pause" })).toEqual({
      action: "pause",
    });
    expect(() => parseDevelopmentEnvironmentActionRequest({ action: "start" })).toThrow();
    expect(
      parseDevelopmentEnvironmentListResource({
        environments: [
          {
            environmentId: UUID,
            projectId: "22222222-2222-4222-8222-222222222222",
            workspaceId: "33333333-3333-4333-8333-333333333333",
            workspaceName: "agent-runtime",
            state: "running",
            generation: 1,
            profileKey: "standard",
            cpuCount: 2,
            memoryMiB: 4096,
            systemDiskGiB: 16,
            createdAt,
            updatedAt: createdAt,
          },
        ],
        profiles: [
          {
            key: "standard",
            label: "标准型",
            cpuCount: 2,
            memoryMiB: 4096,
            systemDiskGiB: 16,
            recommended: true,
          },
        ],
        truncated: false,
      }),
    ).toMatchObject({ environments: [{ state: "running" }] });
    expect(() => parseDevelopmentEnvironmentActionRequest({ action: "reimage" })).toThrow();
  });

  it("validates public resources before a browser consumes them", () => {
    const createdAt = "2026-07-19T00:00:00.000Z";
    expect(
      parseProjectResource({
        projectId: "10000000-0000-4000-8000-000000000001",
        workspaceId: "20000000-0000-4000-8000-000000000001",
        name: "Java repair demo",
        createdAt,
        source: { kind: "sample_java", status: "ready" },
        environment: {
          ...ENVIRONMENT_SNAPSHOT,
          state: "pending",
          active: true,
          createdAt,
        },
      }),
    ).toMatchObject({ name: "Java repair demo" });
    expect(
      parseSessionResource({
        sessionId: "30000000-0000-4000-8000-000000000001",
        title: "Repair Java demo",
        projectId: "10000000-0000-4000-8000-000000000001",
        workspaceId: "20000000-0000-4000-8000-000000000001",
        workspaceState: "attached",
        state: "cold",
        executionMode: "development_environment",
        sandboxProfileKey: "standard",
        workingDirectory: "/workspace",
        modelProfileId: "40000000-0000-4000-8000-000000000001",
        createdAt,
      }),
    ).toMatchObject({ state: "cold" });
    expect(
      parseAcceptedTurnResource({
        runId: "50000000-0000-4000-8000-000000000010",
        turnId: "50000000-0000-4000-8000-000000000001",
        sessionId: "30000000-0000-4000-8000-000000000001",
        mailboxPosition: 1,
        state: "queued",
        acceptedAt: createdAt,
        replayed: false,
      }),
    ).toMatchObject({ state: "queued" });
    expect(
      parseAcceptedTurnCancellationResource({
        controlRequestId: "70000000-0000-4000-8000-000000000001",
        targetRunId: "50000000-0000-4000-8000-000000000010",
        turnId: "50000000-0000-4000-8000-000000000001",
        sessionId: "30000000-0000-4000-8000-000000000001",
        state: "pending",
        acceptedAt: createdAt,
        replayed: false,
      }),
    ).toMatchObject({ state: "pending" });
    expect(
      parseControlPlaneApiError({
        error: { code: "conflict", message: "Session already has an active turn" },
      }),
    ).toMatchObject({ error: { code: "conflict" } });
    expect(
      parseTenantIdentityResource({
        tenantId: "80000000-0000-4000-8000-000000000001",
        tenantSlug: "private-alpha",
        userId: "80000000-0000-4000-8000-000000000002",
        username: "alpha.operator",
        displayName: "Alpha Operator",
        role: "member",
        authenticationKind: "local",
        platformAdministrator: false,
      }),
    ).toMatchObject({ username: "alpha.operator", tenantSlug: "private-alpha", role: "member" });
    expect(
      parseTenantRegistrationResource({
        tenantId: "80000000-0000-4000-8000-000000000001",
        tenantSlug: "public-alpha",
        userId: "80000000-0000-4000-8000-000000000002",
        displayName: "Alpha Owner",
        role: "owner",
        apiToken: `pck_80000000-0000-4000-8000-000000000003.${"a".repeat(43)}`,
      }),
    ).toMatchObject({ tenantSlug: "public-alpha", role: "owner" });
    expect(
      parseConversationListResource({
        conversations: [
          {
            sessionId: "30000000-0000-4000-8000-000000000001",
            title: "Repair checkout",
            projectId: "10000000-0000-4000-8000-000000000001",
            workspaceId: "20000000-0000-4000-8000-000000000001",
            workspaceName: "Java repair demo",
            workspaceState: "attached",
            state: "idle",
            executionMode: "elastic",
            sandboxProfileKey: "standard",
            workingDirectory: "/workspace",
            turnCount: 1,
            createdAt,
            updatedAt: createdAt,
            lastActiveAt: createdAt,
          },
        ],
        delegatedSessions: [],
        truncated: false,
      }),
    ).toMatchObject({ conversations: [{ title: "Repair checkout" }] });
    expect(
      parseConversationDetailResource({
        project: {
          projectId: "10000000-0000-4000-8000-000000000001",
          workspaceId: "20000000-0000-4000-8000-000000000001",
          name: "Java repair demo",
          createdAt,
          source: { kind: "sample_java", status: "ready" },
          environment: {
            ...ENVIRONMENT_SNAPSHOT,
            state: "pending",
            active: true,
            createdAt,
          },
        },
        session: {
          sessionId: "30000000-0000-4000-8000-000000000001",
          title: "Repair checkout",
          projectId: "10000000-0000-4000-8000-000000000001",
          workspaceId: "20000000-0000-4000-8000-000000000001",
          workspaceState: "attached",
          state: "running",
          executionMode: "development_environment",
          sandboxProfileKey: "performance",
          workingDirectory: "/workspace/app",
          modelProfileId: "40000000-0000-4000-8000-000000000001",
          createdAt,
          updatedAt: createdAt,
          lastActiveAt: createdAt,
        },
        inheritedMessages: [],
        turns: [
          {
            runId: "50000000-0000-4000-8000-000000000010",
            turnId: "50000000-0000-4000-8000-000000000001",
            mailboxPosition: 1,
            prompt: "repair it",
            state: "running",
            transcript: {
              schemaVersion: 1,
              throughSequence: 4,
              items: [
                {
                  kind: "text",
                  text: "Working on it.",
                  firstSequence: 2,
                  lastSequence: 3,
                },
              ],
              startedSequence: 1,
              terminalSequence: 4,
              stopReason: "stop",
              failure: null,
              cancellation: null,
            },
            acceptedAt: createdAt,
          },
        ],
        historyTruncated: false,
      }),
    ).toMatchObject({
      turns: [
        {
          prompt: "repair it",
          transcript: { throughSequence: 4, items: [{ text: "Working on it." }] },
        },
      ],
    });

    expect(
      parseRunResource({
        runId: "50000000-0000-4000-8000-000000000010",
        traceId: "11111111111111111111111111111111",
        projectId: "10000000-0000-4000-8000-000000000001",
        workspaceId: "20000000-0000-4000-8000-000000000001",
        sessionId: "30000000-0000-4000-8000-000000000001",
        turnId: "50000000-0000-4000-8000-000000000001",
        state: "running",
        environment: ENVIRONMENT_SNAPSHOT,
        attemptCount: 1,
        currentAttemptId: "50000000-0000-4000-8000-000000000011",
        queuedAt: createdAt,
        startedAt: createdAt,
        updatedAt: createdAt,
        attempts: [
          {
            attemptId: "50000000-0000-4000-8000-000000000011",
            attemptNumber: 1,
            state: "running",
            projection: "canonical",
            claimOwnerId: "control-plane-1",
            claimExpiresAt: "2026-07-19T00:01:00.000Z",
            sandboxId: "50000000-0000-4000-8000-000000000012",
            claimedAt: createdAt,
            provisioningAt: createdAt,
            runningAt: createdAt,
            lastHeartbeatAt: createdAt,
            transitions: [
              {
                fromState: null,
                toState: "claimed",
                reason: "outbox_claim",
                occurredAt: createdAt,
              },
              {
                fromState: "claimed",
                toState: "provisioning",
                reason: "run_started",
                occurredAt: createdAt,
              },
              {
                fromState: "provisioning",
                toState: "running",
                reason: "pi_started",
                occurredAt: createdAt,
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ state: "running", attempts: [{ attemptNumber: 1 }] });
  });

  it("rejects malformed public resources", () => {
    expect(() =>
      parseAcceptedTurnResource({
        turnId: "not-a-uuid",
        state: "running",
      }),
    ).toThrow(/accepted-turn resource/);
    expect(() =>
      parseAcceptedTurnResource({
        runId: "50000000-0000-4000-8000-000000000010",
        turnId: "50000000-0000-4000-8000-000000000001",
        sessionId: "30000000-0000-4000-8000-000000000001",
        mailboxPosition: 0,
        state: "queued",
        acceptedAt: "2026-07-19T00:00:00.000Z",
        replayed: false,
      }),
    ).toThrow(/accepted-turn resource/);
    expect(() => parseControlPlaneApiError({ error: { message: "missing code" } })).toThrow(
      /control-plane API error/,
    );
    expect(() =>
      parseTenantIdentityResource({
        tenantId: "80000000-0000-4000-8000-000000000001",
        tenantSlug: "private-alpha",
        userId: "80000000-0000-4000-8000-000000000002",
        displayName: "Alpha Operator",
        role: "admin",
        secretSha256: "must-never-cross-the-API",
      }),
    ).toThrow(/tenant identity resource/);
  });

  it("normalizes project names and preserves prompt text", () => {
    expect(parseCreateProjectRequest({ name: "  PiCloud  " })).toEqual({
      name: "PiCloud",
      source: { kind: "empty" },
    });
    expect(
      parseCreateProjectRequest({ name: "Java fixture", source: { kind: "sample_java" } }),
    ).toEqual({
      name: "Java fixture",
      source: { kind: "sample_java" },
    });
    expect(parseAcceptTurnRequest({ prompt: "  fix the test  ", thinkingLevel: "low" })).toEqual({
      prompt: "  fix the test  ",
      thinkingLevel: "low",
    });
    expect(
      parseCreateTenantRegistrationRequest({
        tenantSlug: "  Team-Alpha  ",
        displayName: "  Alpha Owner  ",
      }),
    ).toEqual({ tenantSlug: "team-alpha", displayName: "Alpha Owner" });
  });

  it("keeps model routes provider-native and rejects credentials", () => {
    expect(
      parseReplaceModelConfigurationRequest({
        provider: "openai-codex",
        modelId: "gpt-5.6-terra",
      }),
    ).toEqual({ provider: "openai-codex", modelId: "gpt-5.6-terra" });
    expect(
      parseModelConfigurationResource({
        mode: "real",
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        configured: true,
        routeVersion: 2,
        updatedAt: "2026-07-19T00:00:00.000Z",
      }),
    ).toMatchObject({ mode: "real", routeVersion: 2 });
    expect(() =>
      parseReplaceModelConfigurationRequest({
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        apiKey: `sk-${"a".repeat(48)}`,
      }),
    ).toThrow(ControlPlaneApiValidationError);
    expect(
      parseModelCatalogResource({
        models: [
          {
            provider: "openai-codex",
            modelId: "gpt-5.6-terra",
            displayName: "GPT-5.6 Terra",
            default: true,
          },
        ],
      }),
    ).toMatchObject({ models: [{ default: true }] });
    expect(
      parseUpdateSessionModelRequest({
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
      }),
    ).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro" });
    expect(
      parseSessionModelResource({
        sessionId: UUID,
        modelProfileId: "40000000-0000-4000-8000-000000000001",
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
      }),
    ).toMatchObject({ modelId: "deepseek-v4-pro" });
    expect(() =>
      parseModelConfigurationResource({
        mode: "real",
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        configured: true,
        routeVersion: 2,
        updatedAt: "2026-07-19T00:00:00.000Z",
        apiKey: "must-not-cross",
      }),
    ).toThrow(ControlPlaneApiValidationError);
  });

  it("validates workspace and path identities as UUIDs", () => {
    expect(parseCreateSessionRequest({ workspaceId: UUID, title: "  Fix checkout  " })).toEqual({
      workspaceId: UUID,
      title: "Fix checkout",
      executionMode: "elastic",
    });
    expect(parseUuidPathParameter(UUID, "sessionId")).toBe(UUID);
    expect(() => parseUuidPathParameter("session-1", "sessionId")).toThrow(
      ControlPlaneApiValidationError,
    );
  });

  it("accepts only built-in Workspace seeds", () => {
    expect(parseCreateProjectRequest({ name: "Empty" })).toEqual({
      name: "Empty",
      source: { kind: "empty" },
    });
    expect(parseCreateProjectRequest({ name: "Fixture", source: { kind: "sample_java" } })).toEqual(
      { name: "Fixture", source: { kind: "sample_java" } },
    );
    expect(() =>
      parseCreateProjectRequest({
        name: "Repository",
        source: { kind: "github_public", repository: "octocat/repo", commitSha: "a".repeat(40) },
      }),
    ).toThrow(ControlPlaneApiValidationError);
  });

  it("rejects whitespace-only values, extra fields, and unsupported thinking levels", () => {
    expect(() => parseCreateProjectRequest({ name: "   " })).toThrow(
      "Project name must contain a non-whitespace character",
    );
    expect(() => parseAcceptTurnRequest({ prompt: "\n\t" })).toThrow(
      "Turn prompt must contain a non-whitespace character",
    );
    expect(() => parseAcceptTurnRequest({ prompt: "hello", rawProvider: "secret" })).toThrow(
      ControlPlaneApiValidationError,
    );
    expect(() => parseAcceptTurnRequest({ prompt: "hello", thinkingLevel: "turbo" })).toThrow(
      ControlPlaneApiValidationError,
    );
    expect(() =>
      parseCreateTenantRegistrationRequest({ tenantSlug: "bad slug", displayName: "Owner" }),
    ).toThrow(ControlPlaneApiValidationError);
    expect(() =>
      parseCreateTenantRegistrationRequest({
        tenantSlug: "valid-slug",
        displayName: "x".repeat(257),
      }),
    ).toThrow(ControlPlaneApiValidationError);
  });

  it("accepts portable idempotency keys and rejects ambiguous header values", () => {
    expect(parseIdempotencyKey("request-01:retry.2")).toBe("request-01:retry.2");
    expect(() => parseIdempotencyKey(undefined)).toThrow(ControlPlaneApiValidationError);
    expect(() => parseIdempotencyKey(["one", "two"])).toThrow(ControlPlaneApiValidationError);
    expect(() => parseIdempotencyKey("contains whitespace")).toThrow(
      ControlPlaneApiValidationError,
    );
  });

  it("accepts a bounded cancellation grace period and rejects extra fields", () => {
    expect(parseCreateTurnCancellationRequest({})).toEqual({});
    expect(parseCreateTurnCancellationRequest({ gracePeriodMs: 2_000 })).toEqual({
      gracePeriodMs: 2_000,
    });
    expect(() => parseCreateTurnCancellationRequest({ gracePeriodMs: -1 })).toThrow(
      ControlPlaneApiValidationError,
    );
    expect(() => parseCreateTurnCancellationRequest({ gracePeriodMs: 30_001 })).toThrow(
      ControlPlaneApiValidationError,
    );
    expect(() => parseCreateTurnCancellationRequest({ reason: "shutdown" })).toThrow(
      ControlPlaneApiValidationError,
    );
  });
});
