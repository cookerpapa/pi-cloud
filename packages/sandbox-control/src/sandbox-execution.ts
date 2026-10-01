import type { ToolWorkerInput } from "@pi-cloud/protocol";

/** Immutable fixed guest transport metadata. It grants no lifecycle authority. */
export type SandboxExecutionTarget = Readonly<{
  apiUrl: string;
  sandboxId: string;
  nodeId: string;
  bootId: string;
}>;
export type SandboxExecutionDescriptor = Readonly<{
  version: 1;
  target: SandboxExecutionTarget;
  initialization: Extract<ToolWorkerInput, { type: "worker.initialize" }>;
}>;

export type SandboxBindingSnapshot = Readonly<{
  assignment: import("@pi-cloud/protocol").ToolSandboxAssignment;
  physicalActivationId: string;
  turnContextSha256: string;
  executionContextSha256: string;
  allowedTools: readonly import("@pi-cloud/protocol").CloudToolName[];
  sandboxProfileKey: import("@pi-cloud/protocol").DevelopmentEnvironmentProfileKey;
  developmentEnvironmentId?: string;
  computeSessionId?: string;
}>;
