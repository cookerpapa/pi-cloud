import type { ExecuteTurnCommandMessage } from "@pi-cloud/protocol";
import { createWorkspaceSeed } from "@pi-cloud/workspace-runtime";

/** Pure claimed metadata, with no guest effect. Native Pi owns pending Stop. */
export async function resolveWorkspaceSeed(
  command: ExecuteTurnCommandMessage,
): Promise<Uint8Array | undefined> {
  return command.payload.workspaceSeedKind === "sample_java" ? undefined : createWorkspaceSeed([]);
}
