import { randomUUID } from "node:crypto";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
import { SandboxControlClient } from "@pi-cloud/sandbox-control/client";
import type {
  ToolSandboxAssignment,
  SandboxControlRequest,
  SkillPackageContent,
} from "@pi-cloud/protocol";

/** Ordinary handlers never take over resources. The current Session owner still
 * admits every data-channel operation and closes it with its binding. */
export class ToolHostResourceClient {
  readonly #client: SandboxControlClient;
  constructor(readonly options: { baseUrl: string; token: string }) {
    this.#client = new SandboxControlClient({
      baseUrl: options.baseUrl,
      serviceToken: options.token,
      allowInsecureHttp: true,
      requestTimeoutMs: 900_000,
    });
  }
  async #assignment(call: AcceptedControlToolCommand): Promise<ToolSandboxAssignment> {
    if (!call.bindingId) throw new Error("Tool requires an execution binding");
    const environment = call.environment;
    if (
      !environment ||
      environment.requestId !== call.bindingId ||
      environment.assignment.tenantId !== call.scope.tenantId ||
      environment.assignment.runId !== call.scope.runId ||
      environment.piSessionId !== call.scope.piSessionId
    )
      throw new Error("Tool has no matching logical environment");
    return environment.assignment;
  }
  async imageIo(
    call: AcceptedControlToolCommand,
    action: Extract<SandboxControlRequest, { type: "tool_sandbox.image_io" }>["action"],
    signal: AbortSignal,
  ) {
    return this.#client.imageIo(
      {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.image_io",
        requestId: randomUUID(),
        activationId: call.bindingId!,
        assignment: await this.#assignment(call),
        operationId: call.operationId,
        action,
      },
      signal,
    );
  }
  async exportPackage(call: AcceptedControlToolCommand, path: string, signal?: AbortSignal) {
    return this.#client.exportPackage(
      {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.export_package",
        requestId: randomUUID(),
        activationId: call.bindingId!,
        assignment: await this.#assignment(call),
        operationId: call.operationId,
        path,
      },
      signal,
    );
  }
  async preparePackage(
    call: AcceptedControlToolCommand,
    content: SkillPackageContent,
    digest: string,
    signal?: AbortSignal,
  ) {
    return this.#client.preparePackage(
      {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.prepare_package",
        requestId: randomUUID(),
        activationId: call.bindingId!,
        assignment: await this.#assignment(call),
        operationId: call.operationId,
        content,
        digest,
      },
      signal,
    );
  }
  async refreshServices(call: AcceptedControlToolCommand): Promise<void> {
    await this.#client.refreshServices(call.bindingId!, await this.#assignment(call));
  }
}
