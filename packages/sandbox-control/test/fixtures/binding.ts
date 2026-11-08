import { parseExecutionReference } from "@pi-cloud/protocol";
import type { PostgresSandboxBindings } from "../../src/sandbox-bindings.ts";
import type {
  SandboxBindingSnapshot,
  SandboxExecutionDescriptor,
} from "../../src/sandbox-execution.ts";

/** Synthetic route for projection/cancellation tests that intentionally run no
 * VM. Actual allocation and late-registration contracts use register() directly. */
export async function insertTestBinding(
  source: PostgresSandboxBindings,
  bindingId: string,
  descriptor: SandboxExecutionDescriptor,
  snapshot: SandboxBindingSnapshot,
): Promise<void> {
  const identity = parseExecutionReference(snapshot.assignment.executionReference);
  await source.database
    .insertInto("sandbox_tool_bindings")
    .values({
      binding_id: bindingId,
      tenant_id: snapshot.assignment.tenantId,
      run_id: identity.runId,
      writer_id: identity.leaseId,
      sandbox_domain_id: source.sandboxDomainId,
      owner_instance_id: source.instanceId,
      descriptor,
      snapshot,
    })
    .execute();
  await source.publishChanges([bindingId]);
}
