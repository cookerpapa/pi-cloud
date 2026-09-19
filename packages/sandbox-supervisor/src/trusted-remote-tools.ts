import {
  modelSamplingHeaders,
  parseInternalServiceError,
  parseCloudToolCapabilitySnapshot,
  parseToolSandboxOperationResponse,
  parseToolSandboxOperationRequest,
  CLOUD_TOOL_NAMES,
  MAX_TOOL_RESPONSE_BYTES,
  MIN_TOOL_EXECUTION_TIMEOUT_MS,
  MAX_TOOL_EXECUTION_TIMEOUT_MS,
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
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type BashOperations,
  type EditOperations,
  type ReadToolInput,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { FrozenCloudStep } from "./cloud-context.ts";
import type { PiWorldStateModelMessage } from "./pi-sandbox-continuity.ts";
import {
  readWorkflowResult,
  type WorkflowHostCall,
  type WorkflowExecutor,
} from "./workflow-transport.ts";

const HIDDEN_GIT_CREDENTIAL_FILE = ".git-credentials";
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

export function redactToolSecrets(value: Buffer): Buffer {
  const source = value.toString("utf8");
  const redacted = source
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s@/]+(@[^\s]+)/giu, "$1[PI_CLOUD_REDACTED]$2")
    .replace(/\b(?:glpat|gldt|glcbt|glptt)-[A-Za-z0-9._~-]{8,}\b/gu, "[PI_CLOUD_REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}\b/gu, "[PI_CLOUD_REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}\b/gu, "[PI_CLOUD_REDACTED]");
  return redacted === source ? value : Buffer.from(redacted, "utf8");
}

function assertModelReadablePath(path: string): void {
  if (path.split(/[\\/]/u).includes(HIDDEN_GIT_CREDENTIAL_FILE)) {
    throw new RemoteToolError(
      "tool_secret_path",
      "Code Host credentials are not available through file tools",
      false,
    );
  }
}

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
  operationResultUrl?: string;
  activationId?: string;
  resolveOperationTarget?: () =>
    | Promise<Readonly<{ operationResultUrl: string; activationId: string }>>
    | Readonly<{ operationResultUrl: string; activationId: string }>;
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
  "operationResultUrl" | "activationId" | "resolveOperationTarget"
> & {
  resolveOperationTarget(): Promise<Readonly<{ operationResultUrl: string; activationId: string }>>;
};

function validateOperationTarget(target: {
  operationResultUrl: string;
  activationId: string;
}): Readonly<{ operationResultUrl: string; activationId: string }> {
  const parsed = new URL(target.operationResultUrl);
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
  return { operationResultUrl: parsed.toString(), activationId: target.activationId };
}

function validateRuntimeConfiguration(
  candidate: TrustedRemoteToolsRuntimeConfiguration,
): ValidatedRemoteToolsRuntimeConfiguration {
  const staticTarget =
    candidate.operationResultUrl === undefined || candidate.activationId === undefined
      ? undefined
      : validateOperationTarget({
          operationResultUrl: candidate.operationResultUrl,
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

function utf8Head(value: Buffer, maximumBytes: number): Buffer {
  if (value.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (value[end]! & 0xc0) === 0x80) end -= 1;
  return value.subarray(0, end);
}

function utf8Tail(value: Buffer, maximumBytes: number): Buffer {
  if (value.byteLength <= maximumBytes) return value;
  let start = value.byteLength - maximumBytes;
  while (start < value.byteLength && (value[start]! & 0xc0) === 0x80) start += 1;
  return value.subarray(start);
}

function modelOutputPreview(value: Buffer, maximumBytes: number): Buffer {
  if (value.byteLength <= maximumBytes) return value;
  const marker = Buffer.from(
    `\n\n[PiCloud omitted the middle of this output from model context. The omitted output is not archived. For large outputs, write to a Workspace file and inspect it with focused reads. Do not rerun commands with uncertain side effects just to recover output.]\n\n`,
    "utf8",
  );
  const bodyBytes = Math.max(0, maximumBytes - marker.byteLength);
  const headBytes = Math.min(8 * 1_024, Math.floor(bodyBytes / 5));
  const tailBytes = Math.max(0, bodyBytes - headBytes);
  return Buffer.concat([utf8Head(value, headBytes), marker, utf8Tail(value, tailBytes)]);
}

function canonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || decoded.byteLength > MAX_TOOL_RESPONSE_BYTES) {
    throw new RemoteToolError(
      "tool_protocol_error",
      "Tool Sandbox returned invalid binary output",
      false,
    );
  }
  return decoded;
}

function orderedBashOutput(
  response: Extract<
    ToolSandboxOperationResponse,
    { type: "tool_sandbox.operation_result"; operation: "bash.exec" }
  >,
): Buffer {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for (const [index, chunk] of response.outputChunks.entries()) {
    if (chunk.seq !== index + 1) {
      throw new RemoteToolError(
        "tool_output_sequence_invalid",
        "Tool Sandbox returned non-contiguous command output",
        false,
      );
    }
    const bytes = canonicalBase64(chunk.data);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOOL_RESPONSE_BYTES) {
      throw new RemoteToolError(
        "tool_protocol_error",
        "Tool Sandbox command output exceeded its trusted byte limit",
        false,
      );
    }
    chunks.push(bytes);
  }
  const output = Buffer.concat(chunks);
  if (createHash("sha256").update(output).digest("hex") !== response.outputSha256) {
    throw new RemoteToolError(
      "tool_output_digest_mismatch",
      "Tool Sandbox returned corrupt command output",
      false,
    );
  }
  return output;
}

async function responseJson(response: Response): Promise<unknown> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_TOOL_RESPONSE_BYTES) {
    throw new RemoteToolError(
      "tool_protocol_error",
      "Tool Sandbox response was outside its byte limit",
      false,
    );
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new RemoteToolError("tool_protocol_error", "Tool Sandbox returned malformed JSON", false);
  }
}

function throwFailure(
  response: Extract<ToolSandboxOperationResponse, { type: "tool_sandbox.operation_failed" }>,
): never {
  throw new RemoteToolError(response.code, response.message, response.retryable);
}

function errorForPi(error: unknown, timeoutSeconds?: number): Error {
  if (error instanceof RemoteToolError) {
    if (error.code === "tool_timeout") return new Error(`timeout:${String(timeoutSeconds ?? 0)}`);
    if (error.code === "tool_cancelled") return new Error("aborted");
    return new Error(`${error.code}: ${error.message}`);
  }
  return new Error("Tool Sandbox request failed");
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
    workflowProgress?: (value: unknown) => void,
  ): Promise<ToolSandboxOperationResponse> => {
    signal?.throwIfAborted();
    if (currentStep === undefined) {
      throw new RemoteToolError(
        "step_context_unavailable",
        "Tool call preceded its Pi context boundary",
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
    await runtime.publishToolCommand({
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
    });
    const resultUrl = new URL(target.operationResultUrl);
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
        ...(signal ? { signal } : {}),
        ...(workflowProgress ? { progress: workflowProgress } : {}),
      });
    }
    const requestOnce = async (): Promise<{ response: Response; value: unknown }> => {
      const response = await fetch(resultUrl, {
        method: "GET",
        headers: {
          authorization: `Bearer ${runtime.executionReference}`,
          "content-type": "application/json",
          ...(runtime.traceparent === undefined ? {} : { traceparent: runtime.traceparent }),
          ...(runtime.tracestate === undefined ? {} : { tracestate: runtime.tracestate }),
        },
        ...(signal === undefined ? {} : { signal }),
      });
      return { response, value: await responseJson(response) };
    };
    let received: { response: Response; value: unknown } | undefined;
    let transportFailure: unknown;
    for (let attempt = 0; attempt < 2 && received === undefined; attempt += 1) {
      try {
        received = await requestOnce();
      } catch (error: unknown) {
        if (signal?.aborted) throw new Error("aborted");
        if (error instanceof RemoteToolError) throw errorForPi(error);
        transportFailure = error;
      }
    }
    if (received === undefined) throw errorForPi(transportFailure);
    const { response, value } = received;
    if (!response.ok) {
      try {
        const failure = parseInternalServiceError(value).error;
        if (UNAVAILABLE_TOOL_CODES.has(failure.code)) {
          await runtime.onToolOperationUnavailable?.(failure);
        }
        throw new RemoteToolError(failure.code, failure.message, failure.retryable);
      } catch (error: unknown) {
        if (error instanceof RemoteToolError) throw error;
        throw new RemoteToolError(
          "tool_protocol_error",
          "Tool Sandbox returned an invalid failure",
          false,
        );
      }
    }
    const parsed = parseToolSandboxOperationResponse(value);
    if (
      parsed.activationId !== target.activationId ||
      parsed.operationId !== candidate.operationId
    ) {
      throw new RemoteToolError(
        "tool_protocol_error",
        "Tool Sandbox response identity did not match",
        false,
      );
    }
    if (parsed.type === "tool_sandbox.operation_failed") {
      if (UNAVAILABLE_TOOL_CODES.has(parsed.code)) {
        await runtime.onToolOperationUnavailable?.(parsed);
      }
      throwFailure(parsed);
    }
    if (parsed.operation !== candidate.operation) {
      throw new RemoteToolError(
        "tool_protocol_error",
        "Tool Sandbox response kind did not match",
        false,
      );
    }
    return parsed;
  };

  const readOperations = (toolName: "read" | "edit", toolCallId: string): ReadOperations => ({
    readFile: async (path) => {
      try {
        assertModelReadablePath(path);
        const response = await operation(toolName, toolCallId, { operation: "file.read", path });
        if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
        if (response.operation !== "file.read") throw new Error("Tool response kind changed");
        const content = canonicalBase64(response.content);
        return content;
      } catch (error: unknown) {
        throw errorForPi(error);
      }
    },
    access: async (path) => {
      try {
        const response = await operation(toolName, toolCallId, { operation: "file.access", path });
        if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
      } catch (error: unknown) {
        throw errorForPi(error);
      }
    },
    detectImageMimeType: async (path) => {
      switch (extname(path).toLowerCase()) {
        case ".png":
          return "image/png";
        case ".jpg":
        case ".jpeg":
          return "image/jpeg";
        case ".gif":
          return "image/gif";
        case ".webp":
          return "image/webp";
        default:
          return null;
      }
    },
  });
  const writeOperations = (toolCallId: string): WriteOperations => ({
    writeFile: async (path, content) => {
      try {
        assertModelReadablePath(path);
        const response = await operation("write", toolCallId, {
          operation: "file.write",
          path,
          content,
        });
        if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
        if (response.operation !== "file.write") throw new Error("Tool response kind changed");
      } catch (error: unknown) {
        throw errorForPi(error);
      }
    },
    // Pi calls mkdir before writeFile; the remote write performs both under
    // one Broker operation, with the same guest-side path checks.
    mkdir: async (path) => {
      assertModelReadablePath(path);
    },
  });
  const editOperations = (toolCallId: string): EditOperations => {
    const editDigests = new Map<string, string>();
    return {
      readFile: async (path) => {
        try {
          assertModelReadablePath(path);
          const response = await operation("edit", toolCallId, { operation: "file.read", path });
          if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
          if (response.operation !== "file.read") throw new Error("Tool response kind changed");
          const content = canonicalBase64(response.content);
          const actual = createHash("sha256").update(content).digest("hex");
          if (actual !== response.sha256) {
            throw new RemoteToolError(
              "tool_protocol_error",
              "Tool Sandbox returned an invalid file digest",
              false,
            );
          }
          editDigests.set(path, response.sha256);
          return content;
        } catch (error: unknown) {
          throw errorForPi(error);
        }
      },
      writeFile: async (path, content) => {
        assertModelReadablePath(path);
        const expectedSha256 = editDigests.get(path);
        editDigests.delete(path);
        if (expectedSha256 === undefined) {
          throw new Error("tool_edit_conflict: Edit did not read the current file revision");
        }
        try {
          const response = await operation("edit", toolCallId, {
            operation: "file.write",
            path,
            content,
            expectedSha256,
          });
          if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
          if (response.operation !== "file.write") throw new Error("Tool response kind changed");
          const writtenSha256 = createHash("sha256").update(content, "utf8").digest("hex");
          if (writtenSha256 !== response.sha256) {
            throw new RemoteToolError(
              "tool_protocol_error",
              "Tool Sandbox returned an invalid written-file digest",
              false,
            );
          }
        } catch (error: unknown) {
          throw errorForPi(error);
        }
      },
      // A remote read already verifies existence and readability.
      access: async (path) => {
        assertModelReadablePath(path);
      },
    };
  };
  const bashOperations = (toolCallId: string): BashOperations => ({
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const timeoutSeconds = timeout ?? MAX_TOOL_EXECUTION_TIMEOUT_MS / 1_000;
      if (
        !Number.isFinite(timeoutSeconds) ||
        timeoutSeconds < MIN_TOOL_EXECUTION_TIMEOUT_MS / 1_000 ||
        timeoutSeconds > MAX_TOOL_EXECUTION_TIMEOUT_MS / 1_000
      ) {
        throw new Error(
          `Invalid Bash timeout: use ${MIN_TOOL_EXECUTION_TIMEOUT_MS / 1_000}–${MAX_TOOL_EXECUTION_TIMEOUT_MS / 1_000} seconds`,
        );
      }
      try {
        // Deliberately do not forward the `env` argument. It contains the
        // trusted Pi/model environment and must never cross into Tool Sandbox.
        const response = await operation(
          "bash",
          toolCallId,
          {
            operation: "bash.exec",
            command,
            cwd,
            timeoutMs: Math.ceil(timeoutSeconds * 1_000),
          },
          signal,
        );
        if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
        if (response.operation !== "bash.exec") throw new Error("Tool response kind changed");
        const fullOutput = redactToolSecrets(orderedBashOutput(response));
        const maximumModelBytes = Math.min(runtime.maximumToolOutputBytes, DEFAULT_MAX_BYTES);
        // Pi's Bash tool applies its own tail truncation at DEFAULT_MAX_BYTES.
        // Keeping this preview at or below that boundary ensures Pi receives
        // the head/tail preview selected from the original output instead of
        // truncating an already-truncated prefix a second time.
        const output = modelOutputPreview(fullOutput, maximumModelBytes);
        if (output.byteLength > 0) onData(output);
        return { exitCode: response.exitCode };
      } catch (error: unknown) {
        throw errorForPi(error, timeoutSeconds);
      }
    },
  });

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

  if (allowedTools.has("read")) {
    tools.push({
      ...readTool,
      executionMode: CLOUD_TOOL_EXECUTION_MODE,
      async execute(id, params, signal, onUpdate) {
        consumeToolCall();
        const input = params as ReadToolInput;
        if (/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(input.path)) {
          return createReadTool(toolRoot, { operations: readOperations("read", id) }).execute(
            id,
            input,
            signal,
            onUpdate,
          );
        }
        const offsetLine = input.offset ?? 1;
        const requestedLimit = input.limit ?? DEFAULT_MAX_LINES;
        if (
          !Number.isSafeInteger(offsetLine) ||
          offsetLine < 1 ||
          !Number.isSafeInteger(requestedLimit) ||
          requestedLimit < 1
        ) {
          throw new Error("tool_read_range_invalid: offset and limit must be positive integers");
        }
        try {
          const response = await operation(
            "read",
            id,
            {
              operation: "file.read_range",
              path: input.path,
              offsetLine,
              limitLines: Math.min(DEFAULT_MAX_LINES, requestedLimit),
            },
            signal,
          );
          if (response.type === "tool_sandbox.operation_failed") throwFailure(response);
          if (response.operation !== "file.read_range") {
            throw new Error("Tool response kind changed");
          }
          if (response.firstLineBytes !== undefined) {
            return {
              content: [
                {
                  type: "text",
                  text: `[Line ${response.startLine} is ${response.firstLineBytes} bytes, exceeds ${DEFAULT_MAX_BYTES} byte limit. Use bash with sed/head to inspect a bounded slice.]`,
                },
              ],
              details: undefined,
            };
          }
          const range = canonicalBase64(response.content);
          const maximumInlineBytes = Math.min(runtime.maximumToolOutputBytes, DEFAULT_MAX_BYTES);
          let output = modelOutputPreview(range, maximumInlineBytes).toString("utf8");
          if (response.nextOffsetLine !== undefined) {
            output += `\n\n[Showing lines ${response.startLine}-${response.endLine}. Use offset=${response.nextOffsetLine} to continue.]`;
          }
          return { content: [{ type: "text", text: output }], details: undefined };
        } catch (error: unknown) {
          throw errorForPi(error);
        }
      },
    });
  }
  if (allowedTools.has("write")) {
    tools.push({
      ...writeTool,
      executionMode: CLOUD_TOOL_EXECUTION_MODE,
      async execute(id, params, signal, onUpdate) {
        consumeToolCall();
        return createWriteTool(toolRoot, { operations: writeOperations(id) }).execute(
          id,
          params as Parameters<typeof writeTool.execute>[1],
          signal,
          onUpdate,
        );
      },
    });
  }
  if (allowedTools.has("edit")) {
    tools.push({
      ...editTool,
      executionMode: CLOUD_TOOL_EXECUTION_MODE,
      async execute(id, params, signal, onUpdate) {
        consumeToolCall();
        return createEditTool(toolRoot, { operations: editOperations(id) }).execute(
          id,
          params as Parameters<typeof editTool.execute>[1],
          signal,
          onUpdate,
        );
      },
    });
  }
  if (allowedTools.has("bash")) {
    tools.push({
      ...bashTool,
      // Pi's validator accepts unknown properties unless the schema is closed.
      // In particular, silently ignoring `cwd` would execute in the wrong directory.
      parameters: {
        ...bashTool.parameters,
        properties: {
          ...bashTool.parameters.properties,
          timeout: {
            ...bashTool.parameters.properties.timeout,
            minimum: MIN_TOOL_EXECUTION_TIMEOUT_MS / 1_000,
            maximum: MAX_TOOL_EXECUTION_TIMEOUT_MS / 1_000,
            description: `Timeout in seconds (optional, default ${MAX_TOOL_EXECUTION_TIMEOUT_MS / 1_000}; cloud maximum ${MAX_TOOL_EXECUTION_TIMEOUT_MS / 1_000})`,
          },
        },
        additionalProperties: false,
      },
      description: `${bashTool.description}\n\nOnly command and timeout are accepted. Cloud timeout: ${MIN_TOOL_EXECUTION_TIMEOUT_MS / 1_000}–${MAX_TOOL_EXECUTION_TIMEOUT_MS / 1_000} seconds, default ${MAX_TOOL_EXECUTION_TIMEOUT_MS / 1_000}; out-of-range values are rejected. To change directory, use cd inside command (for example: cd /path/to/project && npm test).\n\nFor a long-running service, detach it and redirect stdin, stdout, and stderr (for example: nohup command </dev/null >server.log 2>&1 &). Verify the service in a separate bash call.`,
      executionMode: CLOUD_TOOL_EXECUTION_MODE,
      async execute(id, params, signal, onUpdate) {
        consumeToolCall();
        return createBashTool(toolRoot, { operations: bashOperations(id) }).execute(
          id,
          params as Parameters<typeof bashTool.execute>[1],
          signal,
          onUpdate,
        );
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
          script,
          cwd: toolRoot,
          timeoutMs: MAX_TOOL_EXECUTION_TIMEOUT_MS,
        },
        signal,
        call,
        (value) =>
          onUpdate?.({
            content: [
              { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
            ],
            details: {},
          }),
      );
      if (result.type !== "tool_sandbox.operation_result" || result.operation !== "workflow.exec")
        throw new Error("Workflow returned an invalid response");
      if (!result.ok) throw new Error(result.error ?? "Workflow failed");
      return result.value;
    }) satisfies WorkflowExecutor,
  };
}
