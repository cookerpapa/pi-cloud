import type {
  AgentModelRuntime,
  AssistantMessagePhase,
  ExecuteTurnCommandMessage,
  ProviderHostedWebSearchAction,
} from "@pi-cloud/protocol";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export type AgentWorkspaceSeedResolver = (
  command: ExecuteTurnCommandMessage,
  signal: AbortSignal,
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

export type ProviderHostedActivitySubscriber = (
  listener: (activity: ProviderHostedActivity) => void,
) => () => void;

export type ProviderHostedTranscriptItem = Readonly<{
  outputIndex: number;
  type: string;
  id?: string;
  nativeItem?: Readonly<Record<string, unknown>>;
  annotations?: readonly Readonly<Record<string, unknown>>[];
}>;

export type ProviderHostedTranscript = Readonly<{
  provider: string;
  api: AgentModelRuntime["api"];
  modelId: string;
  stepSequence: number;
  stepSha256: string;
  samplingAttempt: number;
  items: readonly ProviderHostedTranscriptItem[];
}>;

export type ProviderHostedTranscriptSubscriber = (
  listener: (transcript: ProviderHostedTranscript) => void,
) => () => void;

export type TrustedToolExecutionPlane = "platform" | "orchestration" | "integration";

export type TrustedAgentTool = Readonly<{
  executionPlane: TrustedToolExecutionPlane;
  tool: AgentTool;
}>;

export type TrustedModelRuntimeLease = Readonly<{
  runtime: AgentModelRuntime;
  subscribeHostedActivity?: ProviderHostedActivitySubscriber;
  subscribeHostedTranscript?: ProviderHostedTranscriptSubscriber;
  resolveAssistantTextPhase?: AssistantTextPhaseResolver;
  release(): Promise<void> | void;
}>;

/** Text-item order is Pi's text_start order, not its mixed contentIndex. */
export type AssistantTextPhaseResolver = (
  responseId: string,
  textItemIndex: number,
) => AssistantMessagePhase | undefined;

export type TrustedModelRuntimeLeaseResolver = (
  command: ExecuteTurnCommandMessage,
) => Promise<TrustedModelRuntimeLease> | TrustedModelRuntimeLease;
