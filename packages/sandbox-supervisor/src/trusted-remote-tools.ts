import {
  modelSamplingHeaders,
  parseCloudToolCapabilitySnapshot,
  parseToolSandboxOperationRequest,
  CLOUD_TOOL_NAMES,
  MIN_TOOL_EXECUTION_TIMEOUT_MS,
  MAX_TOOL_EXECUTION_TIMEOUT_MS,
  type NativeToolEnd,
  type NativeToolUpdate,
  type CloudToolCapabilitySnapshot,
  type CloudToolName,
  type ToolSandboxOperationRequest,
  type ToolSandboxOperationResponse,
  type ToolCommandPublisher,
} from "@pi-cloud/protocol";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { FrozenCloudStep } from "./cloud-context.ts";
import type { PiWorldStateModelMessage } from "./pi-sandbox-continuity.ts";
import {
  readWorkflowResult,
  type WorkflowHostCall,
  type WorkflowExecutor,
} from "./workflow-transport.ts";

const UNAVAILABLE_TOOL_CODES = new Set([
  "cubesandbox_tool_result_unknown",
  "cubesandbox_tool_unavailable",
  "tool_sandbox_identity_mismatch",
  "tool_command_delivery_unknown",
  "tool_command_executor_closed",
  "tool_command_sealed",
  "tool_operation_outcome_unknown",
  "tool_result_released",
  "stale_session_lease",
  "ownership_lost",
]);

/**
 * Keep each model's Tool batch ordered across remote requests. Other Session
 * bindings may still operate on the same physical Workspace concurrently.
 */
export const CLOUD_TOOL_EXECUTION_MODE = "sequential" as const;

type RemoteOperationInput<T = ToolSandboxOperationRequest> = T extends unknown
  ? Omit<
      T,
      | "toolBrokerProtocolVersion"
      | "type"
      | "activationId"
      | "operationId"
      | "turnContextSha256"
      | "executionContextSha256"
      | "stepContextSequence"
      | "stepContextSha256"
      | "toolName"
    >
  : never;

class RemoteToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "RemoteToolError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type TrustedRemoteToolsRuntimeConfiguration = {
  publishToolCommand: ToolCommandPublisher["publishToolCommand"];
  waitForToolReply?: (
    request: ToolSandboxOperationRequest,
    signal: AbortSignal,
    onUpdate?: (event: NativeToolUpdate) => void,
    toolCallId?: string,
  ) => Promise<NativeToolEnd>;
  workflowUrl?: string;
  activationId?: string;
  resolveOperationTarget?: () =>
    | Promise<Readonly<{ workflowUrl: string; activationId: string }>>
    | Readonly<{ workflowUrl: string; activationId: string }>;
  executionReference: string;
  turnContextSha256: string;
  executionContextSha256: string;
  allowedTools?: CloudToolCapabilitySnapshot;
  captureStepContext: (
    activeTools: readonly string[],
    purpose?: "agent" | "context_maintenance",
  ) =>
    | Readonly<{
        step: FrozenCloudStep;
        modelMessages: readonly PiWorldStateModelMessage[];
        samplingAttempt: number;
      }>
    | Promise<
        Readonly<{
          step: FrozenCloudStep;
          modelMessages: readonly PiWorldStateModelMessage[];
          samplingAttempt: number;
        }>
      >;
  onToolOperationStarted?: () => void | Promise<void>;
  onToolOperationUnavailable?: (
    failure: Readonly<{ code: string; message: string; retryable: boolean }>,
  ) => void | Promise<void>;
  remainingToolCalls: number;
  maximumToolOutputBytes: number;
  workingDirectory: string;
  traceparent?: string;
  tracestate?: string;
};

type ValidatedRemoteToolsRuntimeConfiguration = Omit<
  TrustedRemoteToolsRuntimeConfiguration,
  "workflowUrl" | "activationId" | "resolveOperationTarget"
> & {
  resolveOperationTarget(): Promise<Readonly<{ workflowUrl: string; activationId: string }>>;
};

function validateOperationTarget(target: {
  workflowUrl: string;
  activationId: string;
}): Readonly<{ workflowUrl: string; activationId: string }> {
  const parsed = new URL(target.workflowUrl);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      target.activationId,
    )
  ) {
    throw new Error("Trusted Tool Sandbox operation target is invalid");
  }
  return { workflowUrl: parsed.toString(), activationId: target.activationId };
}

function validateRuntimeConfiguration(
  candidate: TrustedRemoteToolsRuntimeConfiguration,
): ValidatedRemoteToolsRuntimeConfiguration {
  const staticTarget =
    candidate.workflowUrl === undefined || candidate.activationId === undefined
      ? undefined
      : validateOperationTarget({
          workflowUrl: candidate.workflowUrl,
          activationId: candidate.activationId,
        });
  if ((staticTarget === undefined) === (candidate.resolveOperationTarget === undefined)) {
    throw new Error("Trusted Tool Sandbox operation target is ambiguous");
  }
  const resolveOperationTarget = async () =>
    staticTarget ?? validateOperationTarget(await candidate.resolveOperationTarget!());
  const executionReference = candidate.executionReference;
  const turnContextSha256 = candidate.turnContextSha256;
  const executionContextSha256 = candidate.executionContextSha256;
  const remainingToolCalls = candidate.remainingToolCalls;
  const maximumToolOutputBytes = candidate.maximumToolOutputBytes;
  const workingDirectory = candidate.workingDirectory;
  const traceparent = candidate.traceparent;
  const tracestate = candidate.tracestate;
  const allowedTools = parseCloudToolCapabilitySnapshot(
    candidate.allowedTools ?? [...CLOUD_TOOL_NAMES],
  );
  if (
    !/^pcer2_[0-9a-f]{32}_[0-9a-f]{32}_[1-9][0-9]{0,15}$/.test(executionReference) ||
    !/^[0-9a-f]{64}$/.test(turnContextSha256) ||
    !/^[0-9a-f]{64}$/.test(executionContextSha256) ||
    typeof candidate.captureStepContext !== "function" ||
    (candidate.onToolOperationStarted !== undefined &&
      typeof candidate.onToolOperationStarted !== "function") ||
    (candidate.onToolOperationUnavailable !== undefined &&
      typeof candidate.onToolOperationUnavailable !== "function") ||
    !Number.isSafeInteger(remainingToolCalls) ||
    remainingToolCalls < 0 ||
    remainingToolCalls > 10_000 ||
    !Number.isSafeInteger(maximumToolOutputBytes) ||
    maximumToolOutputBytes < 1_024 ||
    maximumToolOutputBytes > 1_048_576 ||
    !workingDirectory.startsWith("/") ||
    workingDirectory.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(workingDirectory)
  ) {
    throw new Error("Trusted Tool Sandbox identity is invalid");
  }
  if (
    traceparent !== undefined &&
    !/^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-0[01]$/.test(traceparent)
  ) {
    throw new Error("Trusted trace context is invalid");
  }
  if (
    tracestate !== undefined &&
    (traceparent === undefined || tracestate.length < 1 || tracestate.length > 512)
  ) {
    throw new Error("Trusted trace state is invalid");
  }
  return {
    publishToolCommand: candidate.publishToolCommand,
    ...(candidate.waitForToolReply ? { waitForToolReply: candidate.waitForToolReply } : {}),
    resolveOperationTarget,
    executionReference,
    turnContextSha256,
    executionContextSha256,
    allowedTools,
    captureStepContext: candidate.captureStepContext,
    ...(candidate.onToolOperationStarted === undefined
      ? {}
      : { onToolOperationStarted: candidate.onToolOperationStarted }),
    ...(candidate.onToolOperationUnavailable === undefined
      ? {}
      : { onToolOperationUnavailable: candidate.onToolOperationUnavailable }),
    remainingToolCalls,
    maximumToolOutputBytes,
    workingDirectory,
    ...(traceparent === undefined ? {} : { traceparent }),
    ...(tracestate === undefined ? {} : { tracestate }),
  };
}

export type TrustedRemoteAgentTools = Readonly<{
  executeWorkflow: WorkflowExecutor;
  tools: readonly AgentTool[];
  systemPrompt(base: string): Promise<string>;
  transformContext(
    messages: AgentMessage[],
    purpose?: "agent" | "context_maintenance",
  ): Promise<AgentMessage[]>;
  transformHeaders(headers?: ProviderHeaders): Promise<ProviderHeaders>;
}>;

/** Pi-native Tool operations and model hooks; no Extension API emulation. */
export function createTrustedRemoteAgentTools(
  configuration: TrustedRemoteToolsRuntimeConfiguration,
): TrustedRemoteAgentTools {
  const runtime = validateRuntimeConfiguration(configuration);
  const tools: AgentTool[] = [];
  let remainingToolCalls = runtime.remainingToolCalls;
  let currentStep: FrozenCloudStep | undefined;
  let currentSamplingAttempt: number | undefined;
  let currentSamplingHeadersIssued = false;

  const captureStep = async (purpose: "agent" | "context_maintenance") => {
    const captured = await runtime.captureStepContext(
      tools.map((tool) => tool.name),
      purpose,
    );
    if (
      captured.step.context.turnContextSha256 !== runtime.turnContextSha256 ||
      captured.step.context.executionContextSha256 !== runtime.executionContextSha256 ||
      !/^[0-9a-f]{64}$/.test(captured.step.sha256)
    ) {
      throw new Error("Captured Cloud Step did not match the accepted Turn and execution contexts");
    }
    currentStep = captured.step;
    currentSamplingAttempt = captured.samplingAttempt;
    currentSamplingHeadersIssued = false;
    return captured;
  };

  const transformContext = async (
    input: readonly AgentMessage[],
    purpose: "agent" | "context_maintenance" = "agent",
  ): Promise<AgentMessage[]> => {
    currentStep = undefined;
    currentSamplingAttempt = undefined;
    const captured = await captureStep(purpose);
    const messages = [...input];
    for (const message of captured.modelMessages) {
      const alreadyPresent = messages.some(
        (candidate) =>
          candidate.role === "custom" &&
          candidate.customType === message.customType &&
          typeof candidate.details === "object" &&
          candidate.details !== null &&
          (candidate.details as { changeSha256?: unknown }).changeSha256 ===
            message.details.changeSha256,
      );
      if (!alreadyPresent) {
        messages.push({
          role: "custom",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
          timestamp: Date.now(),
        });
      }
    }
    return messages;
  };

  const consumeToolCall = (): void => {
    if (remainingToolCalls < 1) {
      throw new Error("tool_budget_exhausted: Run tool-call budget is exhausted");
    }
    remainingToolCalls -= 1;
  };

  const operation = async (
    toolName: CloudToolName,
    toolCallId: string,
    request: RemoteOperationInput,
    signal?: AbortSignal,
    workflowCall?: WorkflowHostCall,
    onUpdate?: (event: NativeToolUpdate) => void,
  ): Promise<ToolSandboxOperationResponse> => {
    signal?.throwIfAborted();
    if (currentStep === undefined) {
      throw new RemoteToolError(
        "step_context_unavailable",
        "step_context_unavailable: Tool call preceded its Pi context boundary",
        false,
      );
    }
    const target = await runtime.resolveOperationTarget();
    await runtime.onToolOperationStarted?.();
    const candidate = parseToolSandboxOperationRequest({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.operation",
      activationId: target.activationId,
      operationId: randomUUID(),
      turnContextSha256: runtime.turnContextSha256,
      executionContextSha256: runtime.executionContextSha256,
      stepContextSequence: currentStep.context.sequence,
      stepContextSha256: currentStep.sha256,
      toolName,
      ...request,
    });
    signal?.throwIfAborted();
    const pendingAbort = new AbortController();
    const replySignal = AbortSignal.any([
      pendingAbort.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(MAX_TOOL_EXECUTION_TIMEOUT_MS + 120_000),
    ]);
    if (!runtime.waitForToolReply) throw new Error("Native Tool reply transport is unavailable");
    const pending = runtime.waitForToolReply(candidate, replySignal, onUpdate, toolCallId);
    await runtime
      .publishToolCommand({
        executionReference: runtime.executionReference,
        toolCallId,
        request: candidate,
        occurredAt: new Date().toISOString(),
        ...(runtime.traceparent
          ? {
              traceContext: {
                traceparent: runtime.traceparent,
                ...(runtime.tracestate ? { tracestate: runtime.tracestate } : {}),
              },
            }
          : {}),
      })
      .catch((error) => {
        pendingAbort.abort(error);
        throw error;
      });
    if (candidate.operation === "tool.execute") {
      const event = await pending.catch((error: unknown) => {
        if (signal?.aborted) throw new Error("aborted");
        throw new Error(
          "tool_operation_outcome_unknown: Tool reply could not be confirmed; do not automatically repeat the command",
          { cause: error },
        );
      });
      return {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.operation_result",
        activationId: target.activationId,
        operationId: candidate.operationId,
        operation: "tool.execute",
        event,
      };
    }
    const resultUrl = new URL(target.workflowUrl);
    resultUrl.searchParams.set("activationId", target.activationId);
    resultUrl.searchParams.set("operationId", candidate.operationId);
    if (candidate.operation === "workflow.exec") {
      if (!workflowCall) throw new Error("Workflow host bridge is unavailable");
      return readWorkflowResult({
        resultUrl,
        executionReference: runtime.executionReference,
        activationId: target.activationId,
        operationId: candidate.operationId,
        call: workflowCall,
        completion: pending,
        ...(signal ? { signal } : {}),
      }).finally(() => pendingAbort.abort(new Error("Workflow bridge closed")));
    }
    throw new Error("Unsupported remote Tool operation");
  };

  const systemPrompt = async (base: string): Promise<string> => {
    const cwdLine = /^Current working directory:.*$/m;
    const sandboxLine = `Current working directory: ${runtime.workingDirectory} (isolated Tool Sandbox)`;
    const basePrompt = cwdLine.test(base)
      ? base.replace(cwdLine, sandboxLine)
      : `${base}\n\n${sandboxLine}`;
    const platformContext = [
      "## PiCloud execution context",
      `All file and command tools operate inside the selected machine directory ${runtime.workingDirectory}.`,
      "Large tool results are bounded in model context; omitted output is not archived.",
      "GitLab/GitHub authentication is already configured through Git's credential helper when the user connects a Code Host.",
      "Always use credential-free HTTPS clone and remote URLs. Never read .git-credentials or embed a token in a command, URL, output, file, or Git remote.",
    ].join("\n");
    return `${basePrompt}\n\n${platformContext}`;
  };

  const transformHeaders = async (headers: ProviderHeaders = {}): Promise<ProviderHeaders> => {
    const result = { ...headers };
    if (runtime.traceparent !== undefined) result.traceparent = runtime.traceparent;
    if (runtime.tracestate !== undefined) result.tracestate = runtime.tracestate;
    // Pi compaction and branch-summary requests use ModelRuntime directly and
    // therefore do not pass through the Agent `context` hook. Give each such
    // maintenance request a fresh governed sampling identity instead of
    // reusing the preceding Agent Step and colliding in the request ledger.
    if (currentSamplingHeadersIssued) await captureStep("context_maintenance");
    if (currentStep === undefined || currentSamplingAttempt === undefined) {
      throw new Error("Model request preceded its Cloud Step capture");
    }
    Object.assign(
      result,
      modelSamplingHeaders({
        stepSequence: currentStep.context.sequence,
        stepSha256: currentStep.sha256,
        samplingAttempt: currentSamplingAttempt,
      }),
    );
    currentSamplingHeadersIssued = true;
    return result;
  };

  const toolRoot = runtime.workingDirectory;
  const readTool = createReadTool(toolRoot);
  const writeTool = createWriteTool(toolRoot);
  const editTool = createEditTool(toolRoot);
  const bashTool = createBashTool(toolRoot);
  const allowedTools = new Set(runtime.allowedTools);

  for (const tool of [readTool, writeTool, editTool, bashTool]) {
    if (!allowedTools.has(tool.name as CloudToolName)) continue;
    const parameters =
      tool.name === "bash"
        ? {
            ...tool.parameters,
            additionalProperties: false,
            properties: {
              ...tool.parameters.properties,
              timeout: {
                ...bashTool.parameters.properties.timeout,
                minimum: MIN_TOOL_EXECUTION_TIMEOUT_MS / 1000,
                maximum: MAX_TOOL_EXECUTION_TIMEOUT_MS / 1000,
              },
            },
          }
        : tool.parameters;
    tools.push({
      ...tool,
      parameters,
      executionMode: CLOUD_TOOL_EXECUTION_MODE,
      ...(tool.name === "bash"
        ? {
            description:
              "Execute a Bash command in the selected working directory. Output is limited to the last 2000 lines or 50 KiB; omitted output is not archived. Only command and timeout are accepted. Use cd inside command to change directory. Timeout defaults to 300 seconds (maximum 300). Detach long-running services and redirect stdin, stdout and stderr.",
          }
        : {}),
      async execute(id, params, signal, onUpdate) {
        consumeToolCall();
        const args = params as Record<string, unknown>;
        const timeout =
          tool.name === "bash" ? (args.timeout ?? MAX_TOOL_EXECUTION_TIMEOUT_MS / 1000) : 60;
        if (
          typeof timeout !== "number" ||
          !Number.isFinite(timeout) ||
          timeout * 1000 < MIN_TOOL_EXECUTION_TIMEOUT_MS ||
          timeout * 1000 > MAX_TOOL_EXECUTION_TIMEOUT_MS
        )
          throw new Error("Invalid Tool timeout");
        const response = await operation(
          tool.name as CloudToolName,
          id,
          {
            operation: "tool.execute",
            toolCallId: id,
            args,
            timeoutMs: Math.ceil(timeout * 1000),
            maximumOutputBytes: runtime.maximumToolOutputBytes,
          },
          signal,
          undefined,
          (event) => onUpdate?.(event.partialResult),
        );
        if (
          response.type !== "tool_sandbox.operation_result" ||
          response.operation !== "tool.execute" ||
          response.event.type !== "tool_execution_end"
        )
          throw new Error("Tool ended without a native result");
        const event = response.event;
        if (event.isError) {
          const message = event.result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          const code = message.split(":", 1)[0]!;
          if (UNAVAILABLE_TOOL_CODES.has(code))
            await runtime.onToolOperationUnavailable?.({ code, message, retryable: false });
          throw new Error(message);
        }
        return event.result;
      },
    });
  }

  return {
    tools,
    systemPrompt,
    transformHeaders,
    transformContext,
    executeWorkflow: (async (toolCallId, script, call, signal, onUpdate) => {
      if (!allowedTools.has("bash"))
        throw new Error("Workflow code requires the Bash execution capability");
      consumeToolCall();
      const result = await operation(
        "bash",
        toolCallId,
        {
          operation: "workflow.exec",
          toolCallId,
          script,
          cwd: toolRoot,
          timeoutMs: MAX_TOOL_EXECUTION_TIMEOUT_MS,
        },
        signal,
        call,
        (event) => onUpdate?.(event.partialResult),
      );
      if (result.type !== "tool_sandbox.operation_result" || result.operation !== "workflow.exec")
        throw new Error("Workflow returned an invalid response");
      if (!result.ok) throw new Error(result.error ?? "Workflow failed");
      return result.value;
    }) satisfies WorkflowExecutor,
  };
}
