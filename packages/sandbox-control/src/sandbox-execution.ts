import type { ToolExecutionAttachment } from "@pi-cloud/protocol";
import { createHash } from "node:crypto";

export function executionTargetId(target: SandboxExecutionTarget): string {
  return createHash("sha256")
    .update(JSON.stringify([target.apiUrl, target.nodeId, target.sandboxId, target.bootId]))
    .digest("hex");
}

/** Immutable fixed guest transport metadata. It grants no lifecycle authority. */
export type SandboxExecutionTarget = Readonly<{
  apiUrl: string;
  sandboxId: string;
  nodeId: string;
  bootId: string;
}>;
export type SandboxExecutionDescriptor = Readonly<{
  version: 2;
  target: SandboxExecutionTarget;
  attachment: ToolExecutionAttachment;
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
