import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CandidateToolCommand } from "@pi-cloud/protocol";

/** Owned adapter boundary, reached by the Runner only after native Pi validation. */
export type PreparedToolExecution = Readonly<{
  command: CandidateToolCommand;
  result(): ReturnType<AgentTool["execute"]>;
  dispose(): void;
}>;

export type PreparedAgentTool = AgentTool & {
  prepareExecution?: (...args: Parameters<AgentTool["execute"]>) => Promise<PreparedToolExecution>;
};
