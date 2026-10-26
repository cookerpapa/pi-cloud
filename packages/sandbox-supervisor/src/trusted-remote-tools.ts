import {
  parseCloudToolCapabilitySnapshot,
  parseToolSandboxOperationRequest,
  CLOUD_TOOL_NAMES,
  MIN_TOOL_EXECUTION_TIMEOUT_MS,
  MAX_TOOL_EXECUTION_TIMEOUT_MS,
  type NativeToolEnd,
  type CloudToolCapabilitySnapshot,
  type CloudToolName,
  type ToolSandboxOperationRequest,
  type ToolSandboxOperationResponse,
  type CandidateToolCommand,
  ToolExecutionFailure,
  ToolResultAttachmentError,
  type ToolReplyWait,
} from "@pi-cloud/protocol";
import type { Message } from "@earendil-works/pi-ai";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { fixedRemoteToolDefinitions } from "./fixed-remote-tool-definitions.ts";
import { randomUUID } from "node:crypto";
import { toolInvocationId } from "./tool-invocation.ts";
import type { PreparedAgentTool } from "./prepared-tool.ts";
import { SamplingContext } from "./sampling-context.ts";
import type { FrozenCloudStep } from "./cloud-context.ts";
import type { PiWorldStateModelMessage } from "./pi-sandbox-continuity.ts";
import {
  readWorkflowResult,
  type WorkflowHostCall,
  type WorkflowPreparer,
} from "./workflow-transport.ts";

import {
  blocksToolSampling,
  confirmsNoToolEffect,
  toolTransportFailure,
  permitsReadinessCheck,
} from "./tool-execution-outcome.ts";

export const REMOTE_TOOL_REPLY_MARGIN_MS = 120_000;

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

export type TrustedRemoteToolsRuntimeConfiguration = {
  observeToolDuration?: (seconds: number, outcome: "completed" | "failed") => void;
  onToolCancellationUnconfirmed?: () => void;
  waitForToolReply?: (
    request: ToolSandboxOperationRequest,
    signals: { receipt: AbortSignal; lifetime: AbortSignal },
    toolCallId?: string,
    imageScope?: { tenantId: string; runId: string },
  ) => ToolReplyWait<NativeToolEnd>;
  confirmExecution?: (bindingId: string, signal: AbortSignal) => Promise<boolean>;
  workflowUrl?: string;
  activationId?: string;
  resolveOperationTarget?: () =>
    | Promise<Readonly<{ workflowUrl: string; activationId: string }>>
    | Readonly<{ workflowUrl: string; activationId: string }>;
  executionReference: string;
  turnContextSha256: string;
  executionContextSha256: string;
  allowedTools?: CloudToolCapabilitySnapshot;
  workspaceAvailable?: boolean;
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
  remainingToolCalls: number | null;
  maximumToolOutputBytes: number;
  workingDirectory: string;
  supportsImages?: boolean;
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
    (remainingToolCalls !== null &&
      (!Number.isSafeInteger(remainingToolCalls) || remainingToolCalls < 0)) ||
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
    ...(candidate.onToolCancellationUnconfirmed
      ? { onToolCancellationUnconfirmed: candidate.onToolCancellationUnconfirmed }
      : {}),
    ...(candidate.observeToolDuration
      ? { observeToolDuration: candidate.observeToolDuration }
      : {}),
    ...(candidate.waitForToolReply ? { waitForToolReply: candidate.waitForToolReply } : {}),
    ...(candidate.confirmExecution ? { confirmExecution: candidate.confirmExecution } : {}),
    resolveOperationTarget,
    executionReference,
    turnContextSha256,
    executionContextSha256,
    allowedTools,
    workspaceAvailable: candidate.workspaceAvailable !== false,
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
    supportsImages: candidate.supportsImages ?? false,
    ...(traceparent === undefined ? {} : { traceparent }),
    ...(tracestate === undefined ? {} : { tracestate }),
  };
}

export type TrustedRemoteAgentTools = Readonly<{
  prepareWorkflow: WorkflowPreparer;
  tools: readonly PreparedAgentTool[];
  systemPrompt(base: string): Promise<string>;
  prepareModelRequest(
    messages: readonly Message[],
    purpose?: "agent" | "context_maintenance",
    headers?: ProviderHeaders,
  ): Promise<{ messages: Message[]; headers: ProviderHeaders }>;
}>;

/** Pi-native Tool operations and model hooks; no Extension API emulation. */
export function createTrustedRemoteAgentTools(
  configuration: TrustedRemoteToolsRuntimeConfiguration,
): TrustedRemoteAgentTools {
  const runtime = validateRuntimeConfiguration(configuration);
  const tools: PreparedAgentTool[] = [];
  let remainingToolCalls = runtime.remainingToolCalls;
  let continuedAfterUnknown = false;
  let readiness: { bindingId: string; result: Promise<boolean> } | undefined;
  const sampling = new SamplingContext({
    turnContextSha256: runtime.turnContextSha256,
    executionContextSha256: runtime.executionContextSha256,
    activeFileTools: runtime.allowedTools!,
    capture: runtime.captureStepContext,
    ...(runtime.traceparent === undefined ? {} : { traceparent: runtime.traceparent }),
    ...(runtime.tracestate === undefined ? {} : { tracestate: runtime.tracestate }),
  });

  const consumeToolCall = (): void => {
    if (remainingToolCalls !== null && remainingToolCalls < 1) {
      throw new Error("tool_budget_exhausted: Run tool-call budget is exhausted");
    }
    if (remainingToolCalls !== null) remainingToolCalls -= 1;
  };

  const prepareOperation = async (
    toolName: CloudToolName,
    toolCallId: string,
    request: RemoteOperationInput,
    signal?: AbortSignal,
    workflowCall?: WorkflowHostCall,
  ): Promise<{
    command: CandidateToolCommand;
    result(): Promise<ToolSandboxOperationResponse>;
    dispose(): void;
    completed(): boolean;
  }> => {
    signal?.throwIfAborted();
    const invocationId = toolInvocationId(toolCallId);
    await sampling.ensureToolContext();
    if (!sampling.step) throw new Error("Tool has no native execution context");
    const target = await runtime.resolveOperationTarget();
    await runtime.onToolOperationStarted?.();
    const candidate = parseToolSandboxOperationRequest({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.operation",
      activationId: target.activationId,
      operationId: randomUUID(),
      ...(request.operation === "workflow.exec"
        ? {
            turnContextSha256: runtime.turnContextSha256,
            executionContextSha256: runtime.executionContextSha256,
            stepContextSequence: sampling.step.context.sequence,
            stepContextSha256: sampling.step.sha256,
          }
        : {}),
      toolName,
      ...request,
    });
    signal?.throwIfAborted();
    const pendingAbort = new AbortController();
    const replyDeadline = AbortSignal.timeout(candidate.timeoutMs + REMOTE_TOOL_REPLY_MARGIN_MS);
    const lifetime = AbortSignal.any([pendingAbort.signal, ...(signal ? [signal] : [])]);
    const replySignal = AbortSignal.any([lifetime, replyDeadline]);
    if (!runtime.waitForToolReply) throw new Error("Native Tool reply transport is unavailable");
    const pending = runtime.waitForToolReply(
      candidate,
      { receipt: replySignal, lifetime },
      toolCallId,
    );
    let cancellationUnconfirmed = false;
    const markCancellationUnconfirmed = () => {
      if (cancellationUnconfirmed) return;
      cancellationUnconfirmed = true;
      runtime.onToolCancellationUnconfirmed?.();
    };
    // The image-decoding adapter adds a Promise above the mailbox. Observe that
    // Promise now: failure/cancellation can precede the command's Kafka ACK.
    void pending.result.catch(() => {});
    const failTransport = async (error: unknown): Promise<never> => {
      if (signal?.aborted) {
        if (!pending.executionSettled() && !confirmsNoToolEffect(error))
          markCancellationUnconfirmed();
        throw confirmsNoToolEffect(error) ? error : signal.reason;
      }
      // The native preparation wrapper records the precise Run interruption.
      // Attachment failure cannot revoke known receipt or diagnose the sandbox.
      if (error instanceof ToolResultAttachmentError) throw error;
      const failure =
        error === replyDeadline.reason && replyDeadline.aborted
          ? new ToolExecutionFailure(
              {
                code: "tool_reply_timeout",
                effect: "unknown",
                message:
                  "No final Tool reply arrived before the deadline. The operation may have executed or may still be running; inspect its effects before deciding to repeat it.",
              },
              { cause: error },
            )
          : toolTransportFailure(error);
      if (
        candidate.operation === "tool.execute" &&
        runtime.confirmExecution &&
        permitsReadinessCheck(failure)
      ) {
        if (!readiness && !continuedAfterUnknown) {
          continuedAfterUnknown = true;
          const check = {
            bindingId: target.activationId,
            result: Promise.resolve()
              .then(() =>
                runtime.confirmExecution!(target.activationId, signal ?? pendingAbort.signal),
              )
              .catch(() => false),
          };
          readiness = check;
          void check.result.finally(() => {
            if (readiness === check) readiness = undefined;
          });
        }
        const check = readiness;
        if (check?.bindingId === target.activationId && (await check.result)) {
          signal?.throwIfAborted();
          continuedAfterUnknown = true;
          throw failure; // Pi commits this error; the next model request may inspect effects.
        }
        signal?.throwIfAborted();
      }
      if (blocksToolSampling(failure)) await runtime.onToolOperationUnavailable?.(failure);
      throw failure;
    };
    return {
      command: {
        executionReference: runtime.executionReference,
        toolCallId: invocationId,
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
      },
      completed: pending.executionSettled,
      dispose: () => {
        if (signal?.aborted && !pending.executionSettled()) markCancellationUnconfirmed();
        pendingAbort.abort(new Error("Tool reply wait closed"));
      },
      result: async () => {
        if (candidate.operation === "tool.execute") {
          const event = await pending.result.catch(failTransport);
          continuedAfterUnknown = false;
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
          return await readWorkflowResult({
            resultUrl,
            executionReference: runtime.executionReference,
            activationId: target.activationId,
            operationId: candidate.operationId,
            call: workflowCall,
            completion: pending.result,
            ...(signal ? { signal } : {}),
          }).catch(failTransport);
        }
        throw new Error("Unsupported remote Tool operation");
      },
    };
  };

  const systemPrompt = async (base: string): Promise<string> => {
    if (!runtime.workspaceAvailable)
      return `${base}\n\nLinux workspace access: none. Only the tools explicitly offered to this Conversation are available.`;
    const cwdLine = /^Current working directory:.*$/m;
    const sandboxLine = `Current working directory: ${runtime.workingDirectory} (isolated Tool Sandbox)`;
    const basePrompt = cwdLine.test(base)
      ? base.replace(cwdLine, sandboxLine)
      : `${base}\n\n${sandboxLine}`;
    const platformContext = [
      "## PiCloud execution context",
      `All file and command tools operate inside the selected machine directory ${runtime.workingDirectory}.`,
      "Large tool results are bounded in model context; omitted output is not archived.",
      "Stopping the conversation requests cancellation of unfinished Tools. Completed background services keep running. If a Tool outcome is unknown, inspect its effects before repeating it.",
      "GitLab/GitHub authentication is already configured through Git's credential helper when the user connects a Code Host.",
      "Always use credential-free HTTPS clone and remote URLs. Never read .git-credentials or embed a token in a command, URL, output, file, or Git remote.",
    ].join("\n");
    return `${basePrompt}\n\n${platformContext}`;
  };

  const allowedTools = new Set(runtime.allowedTools);
  for (const tool of fixedRemoteToolDefinitions()) {
    if (!allowedTools.has(tool.name as CloudToolName)) continue;
    tools.push({
      ...tool,
      async execute() {
        throw new Error("Remote Tool must be prepared and committed by the trusted Runner");
      },
      async prepareExecution(id, params, signal) {
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
        const prepared = await prepareOperation(
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
        );
        return {
          command: prepared.command,
          dispose: prepared.dispose,
          completed: prepared.completed,
          result: async () => {
            const started = performance.now();
            let outcome: "completed" | "failed" = "failed";
            try {
              const response = await prepared.result();
              if (
                response.type !== "tool_sandbox.operation_result" ||
                response.operation !== "tool.execute" ||
                response.event.type !== "tool_execution_end"
              )
                throw new Error("Tool ended without a native result");
              const event = response.event;
              if (
                !runtime.supportsImages &&
                event.result.content.some((part) => part.type === "image")
              )
                throw new Error(
                  "The selected model does not support image input. Select an image-capable model to read this image.",
                );
              outcome = event.isError ? "failed" : "completed";
              return {
                ...event.result,
                isError: event.isError,
              } as import("@earendil-works/pi-durable").ToolExecutionResult;
            } finally {
              try {
                runtime.observeToolDuration?.((performance.now() - started) / 1000, outcome);
              } catch {
                /* Observation failure cannot change the native Tool result. */
              }
            }
          },
        };
      },
    });
  }

  const prepareWorkflow: WorkflowPreparer = async (
    toolCallId,
    script,
    call,
    signal,
    nativeToolName,
  ) => {
    if (!allowedTools.has("bash"))
      throw new Error("Workflow code requires the Bash execution capability");
    consumeToolCall();
    const prepared = await prepareOperation(
      "bash",
      toolCallId,
      {
        operation: "workflow.exec",
        toolCallId,
        script,
        cwd: runtime.workingDirectory,
        timeoutMs: MAX_TOOL_EXECUTION_TIMEOUT_MS,
      },
      signal,
      call,
    );
    return {
      command: { ...prepared.command, nativeToolName },
      dispose: prepared.dispose,
      completed: prepared.completed,
      result: async () => {
        const response = await prepared.result();
        if (
          response.type !== "tool_sandbox.operation_result" ||
          response.operation !== "workflow.exec"
        )
          throw new Error("Workflow returned an invalid response");
        return response.ok
          ? (response.value as import("@earendil-works/pi-durable").ToolExecutionResult)
          : {
              content: [{ type: "text", text: response.error ?? "Workflow failed" }],
              isError: true,
            };
      },
    };
  };
  return {
    tools,
    prepareWorkflow,
    systemPrompt,
    prepareModelRequest: sampling.prepareModelRequest,
  };
}
