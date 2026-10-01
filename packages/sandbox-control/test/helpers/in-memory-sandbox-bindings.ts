import { parseExecutionReference } from "@pi-cloud/protocol";
import type { SandboxBindings, SandboxBinding } from "../../src/sandbox-bindings.ts";

export class InMemorySandboxBindings implements SandboxBindings {
  readonly rows = new Map<string, SandboxBinding>();
  async register(...[bindingId, descriptor, snapshot]: Parameters<SandboxBindings["register"]>) {
    this.rows.set(bindingId, {
      bindingId,
      descriptor,
      snapshot,
      instanceId: "test-controller",
      baseUrl: "http://sandbox-control.test",
      dispatchClosed: false,
    });
  }
  async release(...[bindingId]: Parameters<SandboxBindings["release"]>) {
    this.rows.delete(bindingId);
  }
  async find(...[scope, wholeWriter]: Parameters<SandboxBindings["find"]>) {
    return [...this.rows.values()].filter((row) => {
      const assignment = row.snapshot.assignment;
      const id = parseExecutionReference(assignment.executionReference);
      return (
        assignment.tenantId === scope.tenantId &&
        (wholeWriter ? id.leaseId === scope.writerId : id.runId === scope.runId)
      );
    });
  }
  async adopt(physicalActivationId: string) {
    return [...this.rows.values()]
      .filter((row) => row.snapshot.physicalActivationId === physicalActivationId)
      .map((row) => ({ ...row, closed: row.dispatchClosed }));
  }
  async closeScope(...args: Parameters<SandboxBindings["closeScope"]>) {
    for (const row of await this.find(...args))
      this.rows.set(row.bindingId, { ...row, dispatchClosed: true });
  }
  async closeTarget(target: Parameters<SandboxBindings["closeTarget"]>[0]) {
    for (const row of this.rows.values())
      if (
        row.descriptor.target.sandboxId === target.sandboxId &&
        row.descriptor.target.apiUrl === target.apiUrl &&
        row.descriptor.target.bootId === target.bootId
      )
        this.rows.set(row.bindingId, { ...row, dispatchClosed: true });
  }
  async closePhysical(physicalActivationId: string) {
    for (const row of this.rows.values())
      if (row.snapshot.physicalActivationId === physicalActivationId)
        this.rows.set(row.bindingId, { ...row, dispatchClosed: true });
  }
  async inventory(sandboxId: string) {
    return [...this.rows.values()].filter((row) => row.snapshot.assignment.sandboxId === sandboxId);
  }
  async isAlive() {
    return true;
  }
}
