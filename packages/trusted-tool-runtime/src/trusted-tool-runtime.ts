import type { Database } from "@pi-cloud/database";
import {
  parseCloudToolCapabilitySnapshot,
  type ExecuteTurnCommandMessage,
  type ToolBrokerWorkspaceForkRequest,
  type ToolBrokerWorkspaceForkResponse,
  type ToolSandboxAssignment,
} from "@pi-cloud/protocol";
import {
  createPiSubagentsCloudTool,
  PI_CLOUD_NEUTRAL_SUBAGENT,
  preloadPiSubagentsCloudToolContract,
  type TrustedAgentTool,
} from "@pi-cloud/sandbox-supervisor";
import type { Kysely } from "kysely";
import {
  PostgresSubagentJobProvider,
  type CloudSubagentTreePolicy,
} from "./postgres-subagent-job-provider.ts";
import {
  createCloudContactSupervisorTool,
  createCloudSubagentSupervisorTool,
  PostgresSubagentSupervisorChannel,
} from "./postgres-subagent-supervisor-channel.ts";
import { createCloudPreviewTool } from "./postgres-preview-tool.ts";

export type TrustedToolRunContext = Readonly<{
  command: ExecuteTurnCommandMessage;
  ensureActivation(): Promise<
    Readonly<{ activationId: string; assignment: ToolSandboxAssignment }>
  >;
}>;

export interface TrustedToolRuntime {
  start(): Promise<void>;
  close(): void;
  create(context: TrustedToolRunContext): Promise<readonly TrustedAgentTool[]>;
}

export type PostgresTrustedToolRuntimeOptions = Readonly<{
  database: Kysely<Database>;
  forkWorkspace?: (
    request: ToolBrokerWorkspaceForkRequest,
  ) => Promise<ToolBrokerWorkspaceForkResponse>;
  prioritizeSubagent?: (runId: string) => void;
  treePolicy?: CloudSubagentTreePolicy;
  onBackgroundError?: (error: unknown) => void;
  reaperIntervalMs?: number;
}>;

function option(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function externalState(state: string) {
  switch (state) {
    case "completed":
      return "completed" as const;
    case "failed":
      return "failed" as const;
    case "cancelled":
      return "stopped" as const;
    case "unknown":
      return "blocked" as const;
    case "running":
      return "running" as const;
    default:
      return "queued" as const;
  }
}

function trusted(
  executionPlane: TrustedAgentTool["executionPlane"],
  tool: TrustedAgentTool["tool"],
): TrustedAgentTool {
  return { executionPlane, tool };
}

export class PostgresTrustedToolRuntime implements TrustedToolRuntime {
  readonly #database: Kysely<Database>;
  readonly #jobs: PostgresSubagentJobProvider;
  readonly #supervisor: PostgresSubagentSupervisorChannel;
  readonly #prioritizeSubagent: ((runId: string) => void) | undefined;
  readonly #onBackgroundError: ((error: unknown) => void) | undefined;
  readonly #reaperIntervalMs: number;
  #reaper: NodeJS.Timeout | undefined;

  constructor(options: PostgresTrustedToolRuntimeOptions) {
    this.#database = options.database;
    this.#jobs = new PostgresSubagentJobProvider({
      database: options.database,
      ...(options.forkWorkspace === undefined ? {} : { forkWorkspace: options.forkWorkspace }),
      ...(options.treePolicy === undefined ? {} : { treePolicy: options.treePolicy }),
    });
    this.#supervisor = new PostgresSubagentSupervisorChannel(options.database);
    this.#prioritizeSubagent = options.prioritizeSubagent;
    this.#onBackgroundError = options.onBackgroundError;
    this.#reaperIntervalMs = options.reaperIntervalMs ?? 60_000;
  }

  async start(): Promise<void> {
    await Promise.all([preloadPiSubagentsCloudToolContract(), this.#reapStalePreparations()]);
    this.#reaper = setInterval(() => void this.#reapStalePreparations(), this.#reaperIntervalMs);
    this.#reaper.unref();
  }

  close(): void {
    if (this.#reaper !== undefined) clearInterval(this.#reaper);
    this.#reaper = undefined;
  }

  async create({
    command,
    ensureActivation,
  }: TrustedToolRunContext): Promise<readonly TrustedAgentTool[]> {
    const preview = trusted(
      "platform",
      createCloudPreviewTool({
        database: this.#database,
        tenantId: command.payload.tenantId,
        sessionId: command.payload.sessionId,
      }),
    );
    const session = await this.#database
      .selectFrom("sessions")
      .select("session_kind")
      .where("tenant_id", "=", command.payload.tenantId)
      .where("id", "=", command.payload.sessionId)
      .executeTakeFirstOrThrow();
    const treeContext =
      session.session_kind === "subagent"
        ? await this.#jobs.treeContext(command.payload.tenantId, command.payload.runId)
        : undefined;
    const contact =
      treeContext === undefined
        ? undefined
        : trusted(
            "orchestration",
            createCloudContactSupervisorTool({
              channel: this.#supervisor,
              tenantId: command.payload.tenantId,
              childSessionId: command.payload.sessionId,
              childRunId: command.payload.runId,
            }),
          );
    const supervisor = trusted(
      "orchestration",
      createCloudSubagentSupervisorTool({
        channel: this.#supervisor,
        jobs: this.#jobs,
        tenantId: command.payload.tenantId,
        parentSessionId: command.payload.sessionId,
      }),
    );
    if (treeContext !== undefined && !treeContext.canSpawnChildren) {
      return [preview, ...(contact === undefined ? [] : [contact]), supervisor];
    }

    const delegation = trusted(
      "orchestration",
      await createPiSubagentsCloudTool({
        context: {
          parentSessionId: command.payload.sessionId,
          model: {
            provider: command.payload.model.provider,
            id: command.payload.model.modelId,
          },
          thinkingLevel: command.payload.model.thinkingLevel,
        },
        coordinator: {
          start: async (input, parentToolCallId) => {
            if (input.agent !== PI_CLOUD_NEUTRAL_SUBAGENT) {
              throw new Error("PiCloud role profiles were removed; use the neutral cloud child");
            }
            const contextMode = option(input.options, "contextMode");
            const workspaceMode = option(input.options, "workspaceMode");
            if (contextMode !== "fresh" && contextMode !== "branch") {
              throw new Error("pi-subagents provided an invalid context mode");
            }
            if (
              workspaceMode !== "none" &&
              workspaceMode !== "shared" &&
              workspaceMode !== "isolated"
            ) {
              throw new Error("pi-subagents provided an unsupported Workspace mode");
            }
            const tools = parseCloudToolCapabilitySnapshot(input.options.requestedToolCapabilities);
            const systemPrompt = option(input.options, "systemPrompt");
            const parentActivation =
              workspaceMode === "isolated" ? await ensureActivation() : undefined;
            const child = await this.#jobs.start({
              tenantId: command.payload.tenantId,
              parentSessionId: command.payload.sessionId,
              parentRunId: command.payload.runId,
              parentExecutionLease: command.payload.executionLease,
              parentToolCallId,
              workflowRunId: input.runId,
              stepIndex: input.stepIndex,
              agentName: input.agent,
              prompt: input.prompt,
              ...(systemPrompt === undefined ? {} : { systemPrompt }),
              contextMode,
              workspaceMode,
              requestedToolCapabilities: tools,
              ...(parentActivation === undefined ? {} : { parentActivation }),
            });
            this.#prioritizeSubagent?.(child.childRunId);
            return {
              providerJobId: child.executionId,
              state: externalState(child.state),
            };
          },
          status: async (providerJobId) => {
            const child = await this.#jobs.status(command.payload.tenantId, providerJobId);
            const coordination = await this.#supervisor.latestForExecution(
              command.payload.tenantId,
              providerJobId,
            );
            return {
              providerJobId,
              state: coordination?.expectsReply === true ? "blocked" : externalState(child.state),
              ...(coordination === undefined
                ? {}
                : {
                    coordinationRequest: {
                      requestId: coordination.requestId,
                      reason: coordination.reason,
                      message: coordination.message,
                      expectsReply: coordination.expectsReply,
                    },
                  }),
              ...(child.failureCode === undefined ? {} : { failureCode: child.failureCode }),
              ...(child.failureMessage === undefined
                ? {}
                : { failureMessage: child.failureMessage }),
            };
          },
          result: async (providerJobId) => {
            const child = await this.#jobs.result(command.payload.tenantId, providerJobId);
            return {
              providerJobId,
              state: externalState(child.state),
              ...(child.output === undefined ? {} : { output: child.output }),
              ...(child.failureCode === undefined ? {} : { failureCode: child.failureCode }),
              ...(child.failureMessage === undefined
                ? {}
                : { failureMessage: child.failureMessage }),
            };
          },
          reattach: async (providerJobId) => {
            const child = await this.#jobs.status(command.payload.tenantId, providerJobId);
            return { providerJobId, state: externalState(child.state) };
          },
          cancel: async (providerJobId) => {
            const child = await this.#jobs.cancel(command.payload.tenantId, providerJobId);
            return { providerJobId, state: externalState(child.state) };
          },
        },
      }),
    );
    return [preview, ...(contact === undefined ? [] : [contact]), delegation, supervisor];
  }

  async #reapStalePreparations(): Promise<void> {
    try {
      await this.#jobs.reapStalePreparations();
    } catch (error: unknown) {
      this.#onBackgroundError?.(error);
    }
  }
}
