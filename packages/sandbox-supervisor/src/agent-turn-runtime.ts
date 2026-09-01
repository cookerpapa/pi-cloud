import type { AgentModelRuntime, ExecuteTurnCommandMessage } from "@pi-cloud/protocol";

export type AgentTurnScenario =
  "text" | "java_repair" | "java_followup" | "coding_eval" | "tool_hold" | "timeout";

export type AgentTurnScenarioContext = {
  command: ExecuteTurnCommandMessage;
  restoring: boolean;
};

export type AgentTurnScenarioResolver = (context: AgentTurnScenarioContext) => AgentTurnScenario;

export type AgentWorkspaceSeedResolver = (
  command: ExecuteTurnCommandMessage,
  signal: AbortSignal,
) => Promise<Uint8Array | undefined> | Uint8Array | undefined;

export type ProviderHostedActivity = Readonly<
  | { phase: "started"; toolName: "web_search" }
  | { phase: "completed"; toolName: "web_search"; outcome: "completed" | "failed" }
>;

export type ProviderHostedActivitySubscriber = (
  listener: (activity: ProviderHostedActivity) => void,
) => () => void;

export type TrustedModelRuntimeLease = Readonly<{
  runtime: AgentModelRuntime;
  subscribeHostedActivity?: ProviderHostedActivitySubscriber;
  release(): Promise<void> | void;
}>;

export type TrustedModelRuntimeLeaseResolver = (
  command: ExecuteTurnCommandMessage,
) => Promise<TrustedModelRuntimeLease> | TrustedModelRuntimeLease;
