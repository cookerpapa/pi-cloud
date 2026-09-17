import type { ExecuteTurnCommandMessage } from "@pi-cloud/protocol";
import { PiTurnError } from "@pi-cloud/sandbox-supervisor";
import { createWorkspaceSeed } from "@pi-cloud/workspace-runtime";

/** Immutable seed kind was read by the tenant-scoped, locked Run claim. */
export async function resolveWorkspaceSeed(
  command: ExecuteTurnCommandMessage,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  if (signal.aborted) {
    throw new PiTurnError("workspace_seed_cancelled", "Workspace setup was cancelled", true);
  }
  return command.payload.workspaceSeedKind === "sample_java" ? undefined : createWorkspaceSeed([]);
}
