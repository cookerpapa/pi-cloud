import { validateToolArguments } from "@earendil-works/pi-ai";
import { createExecutionReference, type CandidateToolCommand } from "@pi-cloud/protocol";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrustedRemoteAgentTools, redactToolSecrets } from "../src/trusted-remote-tools.ts";

const TURN_CONTEXT_SHA256 = "b".repeat(64);
const ATTEMPT_CONTEXT_SHA256 = "e".repeat(64);
const EXECUTION_LEASE = createExecutionReference(
  "10000000-0000-4000-8000-000000000010",
  "10000000-0000-4000-8000-000000000011",
  1,
);

function createStepCapture() {
  let sequence = 0;
  return (activeTools: readonly string[]) => {
    sequence += 1;
    const context = {
      schemaVersion: 2 as const,
      sequence,
      turnContextSha256: TURN_CONTEXT_SHA256,
      executionContextSha256: ATTEMPT_CONTEXT_SHA256,
      activeTools: [...activeTools].sort(),
      worldState: {
        sandbox: { status: "inactive" as const, continuitySha256: null },
        environmentSha256: "c".repeat(64),
        workspaceBindingSha256: "f".repeat(64),

        toolPolicySha256: "d".repeat(64),
      },
    };
    return {
      step: {
        context,
        sha256: createHash("sha256").update(JSON.stringify(context)).digest("hex"),
      },
      modelMessages: [],
      samplingAttempt: 1,
    };
  };
}

let latestPublishedCommand: CandidateToolCommand | undefined;
function publishedRequest(init: RequestInit) {
  expect(init.method).toBe("GET");
  expect(init.body).toBeUndefined();
  if (!latestPublishedCommand)
    throw new Error("HTTP result read preceded Kafka command publication");
  return latestPublishedCommand.request;
}
const BASE_CONFIGURATION = {
  async publishToolCommand(command: CandidateToolCommand) {
    latestPublishedCommand = command;
    return { operationId: command.request.operationId, accepted: true as const };
  },
  operationResultUrl: "http://127.0.0.1:4999/v1/tool-operations",
  activationId: "10000000-0000-4000-8000-000000000001",
  executionReference: EXECUTION_LEASE,
  turnContextSha256: TURN_CONTEXT_SHA256,
  executionContextSha256: ATTEMPT_CONTEXT_SHA256,
  captureStepContext: createStepCapture(),
  remainingToolCalls: 0,
  maximumToolOutputBytes: 1_024,

  workingDirectory: "/workspace",
  traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
} as const;

afterEach(() => {
  latestPublishedCommand = undefined;
  vi.unstubAllGlobals();
});

describe("trusted remote Agent tools", () => {
  it.each([
    { timeout: undefined, timeoutMs: 300_000 },
    { timeout: 0.1, timeoutMs: 100 },
    { timeout: 37.25, timeoutMs: 37_250 },
    { timeout: 300, timeoutMs: 300_000 },
  ])("preserves the declared Bash timeout policy: %j", async ({ timeout, timeoutMs }) => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const request = publishedRequest(init);
      expect(request).toMatchObject({ operation: "bash.exec", timeoutMs });
      return new Response(
        JSON.stringify({
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: request.activationId,
          operationId: request.operationId,
          operation: "bash.exec",
          exitCode: 0,
          outputChunks: [],
          outputSha256: createHash("sha256").update("").digest("hex"),
        }),
      );
    });
    const runtime = createTrustedRemoteAgentTools({
      ...BASE_CONFIGURATION,
      captureStepContext: createStepCapture(),
      remainingToolCalls: 1,
    });
    await runtime.transformContext([]);
    const bash = runtime.tools.find((tool) => tool.name === "bash")!;
    await bash.execute(
      "default-timeout",
      { command: "npm test", timeout },
      new AbortController().signal,
      () => undefined,
    );
    expect(bash.parameters).toMatchObject({
      properties: { timeout: { minimum: 0.1, maximum: 300 } },
    });
    expect(bash.description).toContain("default 300");
  });

  it.each([0, -1, 0.05, 301, Number.POSITIVE_INFINITY])(
    "rejects Bash timeout %s before publication instead of silently changing it",
    async (timeout) => {
      vi.stubGlobal("fetch", async () => {
        throw new Error("Unexpected remote IO");
      });
      const publishToolCommand = vi.fn(BASE_CONFIGURATION.publishToolCommand);
      const runtime = createTrustedRemoteAgentTools({
        ...BASE_CONFIGURATION,
        captureStepContext: createStepCapture(),
        publishToolCommand,
        remainingToolCalls: 1,
      });
      await runtime.transformContext([]);
      const bash = runtime.tools.find((tool) => tool.name === "bash")!;
      expect(() =>
        validateToolArguments(bash, {
          type: "toolCall",
          id: "invalid-timeout",
          name: "bash",
          arguments: { command: "npm test", timeout },
        }),
      ).toThrow(/timeout/iu);
      await expect(
        bash.execute(
          "invalid-timeout",
          { command: "npm test", timeout },
          new AbortController().signal,
          () => undefined,
        ),
      ).rejects.toThrow(/timeout/iu);
      expect(publishToolCommand).not.toHaveBeenCalled();
    },
  );

  it.each(["cwd", "env", "timeuot"])(
    "rejects unsupported Bash parameter %s through Pi validation",
    (name) => {
      const runtime = createTrustedRemoteAgentTools(BASE_CONFIGURATION);
      const bash = runtime.tools.find((tool) => tool.name === "bash")!;
      expect(bash.parameters).toMatchObject({ additionalProperties: false });
      expect(() =>
        validateToolArguments(bash, {
          type: "toolCall",
          id: "bad-bash",
          name: "bash",
          arguments: { command: "node --check game.js", [name]: "/home/user/snake-game" },
        }),
      ).toThrow(new RegExp(name));
    },
  );

  it.each([
    { command: "pwd" },
    { command: "cd /home/user/snake-game && node --check game.js", timeout: 20 },
  ])("preserves Pi's declared Bash parameters: %j", (args) => {
    const bash = createTrustedRemoteAgentTools(BASE_CONFIGURATION).tools.find(
      (tool) => tool.name === "bash",
    )!;
    expect(
      validateToolArguments(bash, {
        type: "toolCall",
        id: "valid-bash",
        name: "bash",
        arguments: args,
      }),
    ).toEqual(args);
    expect(bash.description).toContain("use cd inside command");
  });

  it("redacts Code Host tokens and authenticated URLs before model context", () => {
    const source = Buffer.from(
      "https://oauth2:glpat-super-secret-token@gitlab.example.com/group/repo.git\n" +
        "github_pat_abcdefghijklmnopqrstuvwxyz123456\n",
    );
    const redacted = redactToolSecrets(source).toString("utf8");
    expect(redacted).not.toContain("glpat-super-secret-token");
    expect(redacted).not.toContain("github_pat_abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).toContain("[PI_CLOUD_REDACTED]");
  });

  it("exposes governed Tools and model hooks to the SessionStorage Harness", async () => {
    const runtime = createTrustedRemoteAgentTools(BASE_CONFIGURATION);
    expect(runtime.tools.map((tool) => tool.name).sort()).toEqual([
      "bash",
      "edit",
      "read",
      "write",
    ]);
    expect(runtime.tools.every((tool) => tool.executionMode === "sequential")).toBe(true);
    expect(runtime.tools.find((tool) => tool.name === "bash")?.description).toContain(
      "nohup command </dev/null >server.log 2>&1 &",
    );
    await expect(runtime.systemPrompt("Base prompt")).resolves.toContain(
      "Current working directory: /workspace",
    );
    await expect(runtime.transformContext([])).resolves.toEqual([]);
    const headers = { "x-test": "yes" };
    await expect(runtime.transformHeaders(headers)).resolves.toMatchObject({
      "x-test": "yes",
      traceparent: BASE_CONFIGURATION.traceparent,
      "x-pi-cloud-step-sequence": "1",
    });
    expect(headers).toEqual({ "x-test": "yes" });
  });

  it("exposes only the immutable Run capability snapshot to one Agent runtime", () => {
    const runtime = createTrustedRemoteAgentTools({
      ...BASE_CONFIGURATION,
      allowedTools: ["read", "bash"],
    });
    expect(runtime.tools.map((tool) => tool.name)).toEqual(["read", "bash"]);
  });

  it("resolves the physical Sandbox only when the model actually calls a local Tool", async () => {
    const {
      activationId: _activationId,
      operationResultUrl: _operationUrl,
      ...configuration
    } = BASE_CONFIGURATION;
    const resolveOperationTarget = vi.fn(async () => ({
      activationId: "10000000-0000-4000-8000-000000000077",
      operationResultUrl: "http://127.0.0.1:4999/v1/tool-operations",
    }));
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const request = publishedRequest(init) as {
        activationId: string;
        operationId: string;
      };
      return new Response(
        JSON.stringify({
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: request.activationId,
          operationId: request.operationId,
          operation: "file.read_range",
          content: Buffer.from("lazy\n").toString("base64"),
          startLine: 1,
          endLine: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const runtime = createTrustedRemoteAgentTools({
      ...configuration,
      allowedTools: ["read"],
      remainingToolCalls: 1,
      resolveOperationTarget,
    });

    await runtime.systemPrompt("Base prompt");
    await runtime.transformContext([]);
    expect(resolveOperationTarget).not.toHaveBeenCalled();
    await runtime.tools[0]!.execute(
      "tool-call-lazy",
      { path: "README.md" },
      new AbortController().signal,
      () => undefined,
    );
    expect(resolveOperationTarget).toHaveBeenCalledTimes(1);
  });

  it("assigns fresh governed identities to Pi context-maintenance requests", async () => {
    const purposes: Array<string | undefined> = [];
    const capture = createStepCapture();
    const runtime = createTrustedRemoteAgentTools({
      ...BASE_CONFIGURATION,
      captureStepContext: (activeTools, purpose) => {
        purposes.push(purpose);
        return capture(activeTools);
      },
    });

    await runtime.transformContext([]);
    const agentHeaders = await runtime.transformHeaders();
    const compactionHeaders = await runtime.transformHeaders();
    await runtime.transformContext([]);
    const resumedAgentHeaders = await runtime.transformHeaders();

    expect(purposes).toEqual(["agent", "context_maintenance", "agent"]);
    expect(agentHeaders["x-pi-cloud-step-sequence"]).toBe("1");
    expect(compactionHeaders["x-pi-cloud-step-sequence"]).toBe("2");
    expect(resumedAgentHeaders["x-pi-cloud-step-sequence"]).toBe("3");
  });

  it("rejects a Pi tool call before Tool RPC when the durable run budget is exhausted", async () => {
    const runtime = createTrustedRemoteAgentTools(BASE_CONFIGURATION);
    const registered = runtime.tools;
    expect(registered.map((tool) => tool.name).sort()).toEqual(["bash", "edit", "read", "write"]);
    await expect(
      registered
        .find((tool) => tool.name === "read")!
        .execute(
          "tool-call-1",
          { path: "README.md" },
          new AbortController().signal,
          () => undefined,
        ),
    ).rejects.toThrow("tool_budget_exhausted");
  });

  it("captures every Pi sampling boundary and binds Tool RPC to the latest Step", async () => {
    const capturedSteps: Array<ReturnType<ReturnType<typeof createStepCapture>>> = [];
    const capture = createStepCapture();
    const onToolOperationStarted = vi.fn();
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      requestBody = publishedRequest(init) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: requestBody.activationId,
          operationId: requestBody.operationId,
          operation: "bash.exec",
          exitCode: 0,
          outputChunks: [],
          outputSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const runtime = createTrustedRemoteAgentTools({
      ...BASE_CONFIGURATION,
      remainingToolCalls: 2,
      captureStepContext: (activeTools) => {
        const captured = capture(activeTools);
        capturedSteps.push(captured);
        return captured;
      },
      onToolOperationStarted,
    });
    const registered = runtime.tools;

    await expect(
      registered
        .find((tool) => tool.name === "bash")!
        .execute(
          "tool-call-before-step",
          { command: "pwd", timeout: 10 },
          new AbortController().signal,
          () => undefined,
        ),
    ).rejects.toThrow("step_context_unavailable");
    await runtime.transformContext([]);
    await runtime.transformContext([]);
    await registered
      .find((tool) => tool.name === "bash")!
      .execute(
        "tool-call-after-step",
        { command: "pwd", timeout: 10 },
        new AbortController().signal,
        () => undefined,
      );

    expect(capturedSteps.map((entry) => entry.step.context.sequence)).toEqual([1, 2]);
    expect(requestBody).toMatchObject({
      toolName: "bash",
      turnContextSha256: TURN_CONTEXT_SHA256,
      executionContextSha256: ATTEMPT_CONTEXT_SHA256,
      stepContextSequence: 2,
      stepContextSha256: capturedSteps[1]!.step.sha256,
    });
    expect(onToolOperationStarted).toHaveBeenCalledTimes(1);
  });

  it("injects one model-visible world-state delta at repeated context boundaries", async () => {
    const capture = createStepCapture();
    const runtime = createTrustedRemoteAgentTools({
      ...BASE_CONFIGURATION,
      captureStepContext: (activeTools) => ({
        ...capture(activeTools),
        modelMessages: [
          {
            customType: "pi-cloud.sandbox_reset",
            content: "<sandbox_reset>reset</sandbox_reset>",
            display: false,
            details: { schemaVersion: 1, changeSha256: "e".repeat(64) },
          },
        ],
      }),
    });
    const first = await runtime.transformContext([]);
    const second = await runtime.transformContext(first);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it("marks the Step world unavailable when Cube can no longer prove a Tool result", async () => {
    const onToolOperationUnavailable = vi.fn();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "cubesandbox_tool_result_unknown",
              message: "The Cube operation ledger was lost",
              retryable: false,
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    );
    const runtime = createTrustedRemoteAgentTools({
      ...BASE_CONFIGURATION,
      remainingToolCalls: 1,
      onToolOperationUnavailable,
    });
    const registered = runtime.tools;
    await runtime.transformContext([]);

    await expect(
      registered
        .find((tool) => tool.name === "bash")!
        .execute(
          "tool-call-unknown",
          { command: "migrate", timeout: 10 },
          new AbortController().signal,
          () => undefined,
        ),
    ).rejects.toThrow("cubesandbox_tool_result_unknown");
    expect(onToolOperationUnavailable).toHaveBeenCalledTimes(1);
  });

  it("layers bounded project instructions and preserves a large read result", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-cloud-tool-output-test-"));
    try {
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        expect(new Headers(init.headers).get("traceparent")).toBe(BASE_CONFIGURATION.traceparent);
        const request = publishedRequest(init) as {
          activationId: string;
          operationId: string;
          operation: string;
          path?: string;
        };
        const common = {
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: request.activationId,
          operationId: request.operationId,
          operation: request.operation,
        };
        const body =
          request.operation === "file.read_range"
            ? {
                ...common,
                content: Buffer.from("x".repeat(2_048)).toString("base64"),
                startLine: 1,
                endLine: 1,
              }
            : common;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const runtime = createTrustedRemoteAgentTools({
        ...BASE_CONFIGURATION,
        remainingToolCalls: 1,
      });
      const registered = runtime.tools;
      const prompt = await runtime.systemPrompt("Current working directory: /trusted");
      expect(prompt).toContain("Current working directory: /workspace");
      expect(prompt).not.toContain("/trusted");
      await runtime.transformContext([]);
      const providerHeaders = await runtime.transformHeaders();
      expect(providerHeaders.traceparent).toBe(BASE_CONFIGURATION.traceparent);
      expect(providerHeaders["x-pi-cloud-step-sequence"]).toMatch(/^[1-9][0-9]*$/);
      expect(providerHeaders["x-pi-cloud-sampling-attempt"]).toBe("1");

      await registered
        .find((tool) => tool.name === "read")!
        .execute(
          "tool-call-large-read",
          { path: "large.txt" },
          new AbortController().signal,
          () => undefined,
        );
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("selects one bounded head-tail Bash preview without archiving from the original output", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-cloud-bash-preview-test-"));
    try {
      const original = Buffer.from(
        `BEGIN-${"a".repeat(2_000)}-MIDDLE-${"b".repeat(2_000)}-FINAL-COMPILER-ERROR`,
        "utf8",
      );
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        const request = publishedRequest(init) as {
          activationId: string;
          operationId: string;
          operation: string;
        };
        return new Response(
          JSON.stringify({
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.operation_result",
            activationId: request.activationId,
            operationId: request.operationId,
            operation: "bash.exec",
            exitCode: 0,
            outputChunks: [
              { seq: 1, stream: "stdout", data: original.subarray(0, 700).toString("base64") },
              {
                seq: 2,
                stream: "stderr",
                data: original.subarray(700, 1_400).toString("base64"),
              },
              { seq: 3, stream: "stdout", data: original.subarray(1_400).toString("base64") },
            ],
            outputSha256: createHash("sha256").update(original).digest("hex"),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      const runtime = createTrustedRemoteAgentTools({
        ...BASE_CONFIGURATION,
        remainingToolCalls: 1,
      });
      const registered = runtime.tools;
      await runtime.transformContext([]);

      const result = (await registered
        .find((tool) => tool.name === "bash")!
        .execute(
          "tool-call-large-bash",
          { command: "compile", timeout: 10 },
          new AbortController().signal,
          () => undefined,
        )) as {
        content: Array<{ type: string; text: string }>;
        details?: { truncation?: unknown };
      };

      const preview = result.content[0]?.text ?? "";
      expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(1_024);
      expect(preview).toContain("BEGIN-");
      expect(preview).toContain("FINAL-COMPILER-ERROR");
      expect(preview).toContain("omitted output is not archived");
      expect(result.details?.truncation).toBeUndefined();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects non-contiguous Bash output before exposing it to Pi", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const request = publishedRequest(init) as {
        activationId: string;
        operationId: string;
      };
      return new Response(
        JSON.stringify({
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: request.activationId,
          operationId: request.operationId,
          operation: "bash.exec",
          exitCode: 0,
          outputChunks: [
            { seq: 1, stream: "stdout", data: Buffer.from("first").toString("base64") },
            { seq: 3, stream: "stderr", data: Buffer.from("lost").toString("base64") },
          ],
          outputSha256: createHash("sha256").update("firstlost").digest("hex"),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const runtime = createTrustedRemoteAgentTools({
      ...BASE_CONFIGURATION,
      remainingToolCalls: 1,
    });
    const registered = runtime.tools;
    await runtime.transformContext([]);

    await expect(
      registered
        .find((tool) => tool.name === "bash")!
        .execute(
          "tool-call-invalid-output",
          { command: "compile", timeout: 10 },
          new AbortController().signal,
          () => undefined,
        ),
    ).rejects.toThrow("tool_output_sequence_invalid");
  });

  it("binds edit writes to the file revision that Pi actually read", async () => {
    const callIds: string[] = [];

    const original = Buffer.from("before\n", "utf8");
    const originalSha256 = createHash("sha256").update(original).digest("hex");
    let written: string | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const request = publishedRequest(init) as {
        activationId: string;
        operationId: string;
        operation: string;
        content?: string;
        expectedSha256?: string;
      };
      const common = {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.operation_result",
        activationId: request.activationId,
        operationId: request.operationId,
        operation: request.operation,
      };
      if (request.operation === "file.read") {
        callIds.push(latestPublishedCommand!.toolCallId);
        return new Response(
          JSON.stringify({
            ...common,
            content: original.toString("base64"),
            sha256: originalSha256,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (request.operation === "file.write") {
        callIds.push(latestPublishedCommand!.toolCallId);
        expect(request.expectedSha256).toBe(originalSha256);
        written = request.content;
        return new Response(
          JSON.stringify({
            ...common,
            sha256: createHash("sha256").update(request.content!, "utf8").digest("hex"),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(common), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const runtime = createTrustedRemoteAgentTools({
      ...BASE_CONFIGURATION,
      remainingToolCalls: 1,
    });
    const registered = runtime.tools;
    await runtime.transformContext([]);

    await expect(
      registered
        .find((tool) => tool.name === "edit")!
        .execute(
          "tool-call-atomic-edit",
          { path: "example.txt", edits: [{ oldText: "before", newText: "after" }] },
          new AbortController().signal,
          () => undefined,
        ),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in example.txt." }],
    });
    expect(written).toBe("after\n");
    expect(callIds).toEqual(["tool-call-atomic-edit", "tool-call-atomic-edit"]);
  });
});
