import type {
  AgentModelRuntime,
  ExecuteTurnCommandMessage,
  ProviderHostedWebSearchAction,
} from "@pi-cloud/protocol";
import type { ToolRegistration } from "@earendil-works/pi-durable";

export type AgentWorkspaceSeedResolver = (
  command: ExecuteTurnCommandMessage,
) => Promise<Uint8Array | undefined> | Uint8Array | undefined;

export type ProviderHostedActivity = Readonly<
  | { phase: "started"; toolName: "web_search"; activityId: string }
  | {
      phase: "completed";
      toolName: "web_search";
      activityId: string;
      outcome: "completed" | "failed";
      action?: ProviderHostedWebSearchAction;
    }
>;

export type TrustedToolExecutionPlane = "platform" | "orchestration" | "integration";

export type TrustedAgentTool = Readonly<{
  offered?: boolean;
  executionPlane: TrustedToolExecutionPlane;
  tool: ToolRegistration;
}>;

export type TrustedAgentToolSet = Readonly<{
  current(): readonly TrustedAgentTool[];
  subscribe(listener: () => void): () => void;
}>;

export type TrustedModelRuntimeLease = Readonly<{
  runtime: AgentModelRuntime;
  release(): Promise<void> | void;
}>;

export type TrustedModelRuntimeLeaseResolver = (
  command: ExecuteTurnCommandMessage,
  signal?: AbortSignal,
) => Promise<TrustedModelRuntimeLease> | TrustedModelRuntimeLease;
