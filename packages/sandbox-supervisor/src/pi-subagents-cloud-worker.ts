import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  wrapRegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { PI_CLOUD_NEUTRAL_SUBAGENT } from "./pi-subagents-cloud-tool.ts";

type WorkerInput = Readonly<{
  toolCallId: string;
  arguments: Record<string, unknown>;
  parentSessionId: string;
  model?: Readonly<{ provider: string; id: string }>;
  thinkingLevel?: string;
}>;
type ProviderResponse = Readonly<{
  type: "provider.response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  message?: string;
}>;
type ExternalJobStartInput = Readonly<{
  prompt: string;
  promptDigest: string;
  cwd: string;
  runId: string;
  stepIndex: number;
  agent: string;
  options: Record<string, unknown>;
  sessionId?: string;
}>;

const ISOLATED_WORKSPACE_TASK_PREFIX = "[pi-cloud-workspace-mode:isolated]\n";
const CHILD_OPTIONS_PREFIX = "[pi-cloud-child-options:";
const CLOUD_CHILD_AGENT = PI_CLOUD_NEUTRAL_SUBAGENT;

const input = workerData as WorkerInput;
const cloudShimPath = fileURLToPath(new URL("./pi-subagents-cloud-shim.cjs", import.meta.url));
if (parentPort === null) throw new Error("Pi subagent cloud Worker requires a parent port");
const abort = new AbortController();
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const activeProviderJobs = new Set<string>();
const activeCloudWaits = new Set<Promise<unknown>>();
const completedCloudResults = new Map<string, { stepIndex: number; output: string }>();
const blockedCloudResults = new Map<
  string,
  {
    stepIndex: number;
    requestId: string;
    reason: string;
    message: string;
  }
>();
const failedCloudResults = new Map<string, { stepIndex: number; state: string; message: string }>();

function progress(text: string, details: Record<string, unknown>): void {
  parentPort!.postMessage({
    type: "progress",
    result: { content: [{ type: "text", text }], details },
  });
}

parentPort.on("message", (message: ProviderResponse | { type: "abort" }) => {
  if (message.type === "abort") {
    void Promise.allSettled(
      [...activeProviderJobs].map((providerJobId) => request("cancel", { providerJobId })),
    ).finally(() => abort.abort(new Error("Subagent execution was cancelled")));
    return;
  }
  const requestState = pending.get(message.requestId);
  if (requestState === undefined) return;
  pending.delete(message.requestId);
  if (message.ok) requestState.resolve(message.result);
  else requestState.reject(new Error(message.message ?? "Subagent provider request failed"));
});

function request(operation: string, payload: Record<string, unknown>): Promise<unknown> {
  const requestId = randomUUID();
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(requestId, { resolve: resolvePromise, reject: rejectPromise });
    parentPort!.postMessage({ type: "provider.request", requestId, operation, ...payload });
  });
}

function prepareAgentDir(): {
  agentDir: string;
  stateDir: string;
  shimPath: string;
  socketPath: string;
} {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-cloud-subagent-agent-"));
  const stateDir = mkdtempSync(join(tmpdir(), "pi-cloud-subagent-state-"));
  mkdirSync(join(agentDir, "extensions", "subagent"), { recursive: true });
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(
    join(agentDir, "extensions", "subagent", "config.json"),
    `${JSON.stringify({
      asyncByDefault: false,
      defaultSubagentContext: "fresh",
      maxSubagentDepth: 64,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ subagents: { disableBuiltins: true } })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    join(agentDir, "agents", `${CLOUD_CHILD_AGENT}.md`),
    [
      "---",
      `name: ${CLOUD_CHILD_AGENT}`,
      "description: General PiCloud child; behavior comes only from the delegated task and explicit runtime settings",
      "systemPromptMode: append",
      "inheritProjectContext: false",
      "inheritSkills: false",
      "---",
      "Execute only the delegated task and return its result. Do not infer a persona or profession from this internal profile name.",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  const socketPath = join(stateDir, "cloud-runner.sock");
  return { agentDir, stateDir, shimPath: cloudShimPath, socketPath };
}

function parseChildInvocation(value: unknown): ExternalJobStartInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cloud Subagent shim request was invalid");
  }
  const requestValue = value as { args?: unknown; env?: unknown };
  if (
    !Array.isArray(requestValue.args) ||
    requestValue.args.some((arg) => typeof arg !== "string")
  ) {
    throw new Error("Cloud Subagent shim arguments were invalid");
  }
  const args = requestValue.args as string[];
  const env =
    requestValue.env && typeof requestValue.env === "object" && !Array.isArray(requestValue.env)
      ? (requestValue.env as Record<string, unknown>)
      : {};
  const values = new Map<string, string[]>();
  const positionals: string[] = [];
  const valueFlags = new Set([
    "--mode",
    "--session",
    "--session-dir",
    "--model",
    "--thinking",
    "--tools",
    "--extension",
    "--system-prompt",
    "--append-system-prompt",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const candidate = args[index]!;
    if (!candidate.startsWith("-")) {
      positionals.push(candidate);
      continue;
    }
    if (!valueFlags.has(candidate)) continue;
    const selected = args[index + 1];
    if (selected === undefined) throw new Error(`Cloud Subagent flag ${candidate} has no value`);
    const existing = values.get(candidate) ?? [];
    existing.push(selected);
    values.set(candidate, existing);
    index += 1;
  }
  const taskArgument = positionals.at(-1);
  if (taskArgument === undefined) throw new Error("Cloud Subagent task was missing");
  let prompt = taskArgument.startsWith("@")
    ? readFileSync(taskArgument.slice(1), "utf8")
    : taskArgument;
  let cloudContextMode: "fresh" | "fork" = "fresh";
  let cloudRequestedTools: string[] | undefined;
  const cloudOptionsStart = prompt.indexOf(CHILD_OPTIONS_PREFIX);
  if (cloudOptionsStart >= 0) {
    const metadataEnd = prompt.indexOf("]\n", cloudOptionsStart);
    if (metadataEnd < 0) throw new Error("PiCloud Child options marker was truncated");
    const metadata = JSON.parse(
      prompt.slice(cloudOptionsStart + CHILD_OPTIONS_PREFIX.length, metadataEnd),
    ) as Record<string, unknown>;
    if (metadata.context === "fork") cloudContextMode = "fork";
    if (Array.isArray(metadata.tools)) {
      cloudRequestedTools = metadata.tools.filter(
        (tool): tool is string =>
          typeof tool === "string" && ["read", "write", "edit", "bash"].includes(tool),
      );
    }
    prompt = `${prompt.slice(0, cloudOptionsStart)}${prompt.slice(metadataEnd + 2)}`;
  }
  // pi-subagents normally asks a local child process to mirror its final
  // answer into a host-side output file. A cloud child cannot and must not
  // write outside /workspace; its native PostgreSQL Session result is already
  // returned through the provider bridge. Remove only that local transport
  // instruction while preserving the task and acceptance contract.
  prompt = prompt.replace(
    /\n---\n\*\*Output:\*\*\nWrite your findings to exactly this path:[^\n]*\nThis path is authoritative for this run\.\nIgnore any other output filename or output path mentioned elsewhere,[^\n]*\n?/u,
    "\n",
  );
  const isolationMarker = prompt.indexOf(ISOLATED_WORKSPACE_TASK_PREFIX);
  const isolatedWorkspace = isolationMarker >= 0;
  if (isolatedWorkspace) {
    prompt = `${prompt.slice(0, isolationMarker)}${prompt.slice(
      isolationMarker + ISOLATED_WORKSPACE_TASK_PREFIX.length,
    )}`;
  }
  const systemPromptFiles = [
    ...(values.get("--system-prompt") ?? []),
    ...(values.get("--append-system-prompt") ?? []),
  ];
  const systemPrompt = systemPromptFiles.map((file) => readFileSync(file, "utf8")).join("\n\n");
  const explicitTools = values.get("--tools")?.at(-1);
  let requestedToolCapabilities = args.includes("--no-tools")
    ? []
    : explicitTools === undefined
      ? ["read", "write", "edit", "bash"]
      : explicitTools
          .split(",")
          .map((tool) => tool.trim())
          .filter((tool) => ["read", "write", "edit", "bash"].includes(tool));
  if (cloudRequestedTools !== undefined) requestedToolCapabilities = cloudRequestedTools;
  const agent =
    typeof env.PI_SUBAGENT_CHILD_AGENT === "string"
      ? env.PI_SUBAGENT_CHILD_AGENT
      : CLOUD_CHILD_AGENT;
  if (agent !== CLOUD_CHILD_AGENT) {
    throw new Error(`PiCloud supports only the neutral ${CLOUD_CHILD_AGENT} Subagent`);
  }
  const runId = typeof env.PI_SUBAGENT_RUN_ID === "string" ? env.PI_SUBAGENT_RUN_ID : randomUUID();
  const childIndex = Number(env.PI_SUBAGENT_CHILD_INDEX ?? 0);
  const stepIndex = Number.isSafeInteger(childIndex) && childIndex >= 0 ? childIndex : 0;
  return {
    prompt,
    promptDigest: createHash("sha256").update(prompt, "utf8").digest("hex"),
    cwd: directoriesForBridge?.stateDir ?? tmpdir(),
    runId,
    stepIndex,
    agent,
    options: {
      contextMode: cloudContextMode,
      workspaceMode:
        requestedToolCapabilities.length === 0 ? "none" : isolatedWorkspace ? "isolated" : "shared",
      requestedToolCapabilities,
      ...(systemPrompt.length === 0 ? {} : { systemPrompt }),
      ...(values.get("--model")?.at(-1) === undefined
        ? {}
        : { model: values.get("--model")!.at(-1) }),
      ...(values.get("--thinking")?.at(-1) === undefined
        ? {}
        : { thinkingLevel: values.get("--thinking")!.at(-1) }),
    },
    sessionId: input.parentSessionId,
  };
}

function cloudWorkflowScript(script: string, defaultIsolated: boolean): string {
  const marker = JSON.stringify(ISOLATED_WORKSPACE_TASK_PREFIX);
  const optionsPrefix = JSON.stringify(CHILD_OPTIONS_PREFIX);
  const childAgent = JSON.stringify(CLOUD_CHILD_AGENT);
  return [
    `const __piCloudDefaultIsolated = ${String(defaultIsolated)};`,
    `const __piCloudTaskMarker = ${marker};`,
    `const __piCloudOptionsPrefix = ${optionsPrefix};`,
    `const __piCloudAgent = ${childAgent};`,
    "const __piCloudChild = (spec) => {",
    "  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;",
    "  if (spec.agent !== undefined && spec.agent !== __piCloudAgent) throw new Error('PiCloud role profiles were removed; use the neutral cloud-child agent');",
    "  const isolated = spec.worktree === undefined ? __piCloudDefaultIsolated : spec.worktree === true;",
    "  const context = spec.context === 'fork' ? 'fork' : 'fresh';",
    "  const tools = Array.isArray(spec.tools) ? spec.tools : undefined;",
    "  const options = __piCloudOptionsPrefix + JSON.stringify({ context, ...(tools === undefined ? {} : { tools }) }) + ']\\n';",
    "  const task = typeof spec.task === 'string' ? options + (isolated ? __piCloudTaskMarker : '') + spec.task : spec.task;",
    "  const timeoutMs = spec.timeoutMs === undefined ? 300000 : spec.timeoutMs;",
    "  const { context: _context, tools: _tools, ...upstream } = spec;",
    "  return { ...upstream, agent: __piCloudAgent, worktree: false, timeoutMs, ...(task === undefined ? {} : { task }) };",
    "};",
    "const __piCloudRuns = Object.freeze({",
    "  run: (key, spec) => runs.run(key, __piCloudChild(spec)),",
    "  all: (specs) => runs.all(specs.map(__piCloudChild)),",
    "  status: (keyOrRunId) => runs.status(keyOrRunId),",
    "  ref: (result) => runs.ref(result),",
    "  refs: (results) => runs.refs(results),",
    "});",
    `return await (async (runs) => { ${script}\n})(__piCloudRuns);`,
  ].join("\n");
}

function structuredChildWorkflowScript(
  argumentsValue: Record<string, unknown>,
): string | undefined {
  if (argumentsValue.agent !== undefined && argumentsValue.agent !== CLOUD_CHILD_AGENT) {
    return undefined;
  }
  const child = Object.fromEntries(
    ["agent", "task", "resume", "worktree", "model", "thinking", "tools", "context", "cwd"]
      .filter((key) => argumentsValue[key] !== undefined)
      .map((key) => [key, argumentsValue[key]]),
  );
  child.agent = CLOUD_CHILD_AGENT;
  return `return runs.run("main", ${JSON.stringify(child)});`;
}

let directoriesForBridge: ReturnType<typeof prepareAgentDir> | undefined;

async function waitForCloudResult(
  startInput: ExternalJobStartInput,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const started = (await request("start", { input: startInput })) as {
    providerJobId: string;
    state: string;
  };
  activeProviderJobs.add(started.providerJobId);
  progress("Subagent 已进入云端 Worker 队列。", {
    state: started.state,
    agent: startInput.agent,
    stepIndex: startInput.stepIndex,
    elapsedMs: Date.now() - startedAt,
  });
  if (abort.signal.aborted) {
    await request("cancel", { providerJobId: started.providerJobId }).catch(() => undefined);
    activeProviderJobs.delete(started.providerJobId);
    throw abort.signal.reason;
  }
  let state = started.state;
  let previousState = state;
  let latestCoordination:
    | {
        requestId: string;
        reason: string;
        message: string;
        expectsReply: boolean;
      }
    | undefined;
  let latestCoordinationId: string | undefined;
  const deadline = Date.now() + 300_000;
  while (!new Set(["completed", "failed", "stopped", "blocked"]).has(state)) {
    if (abort.signal.aborted) throw abort.signal.reason;
    if (Date.now() >= deadline)
      throw new Error("Cloud Subagent timed out while waiting for its Child Run");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
    const status = (await request("status", { providerJobId: started.providerJobId })) as {
      state: string;
      coordinationRequest?: {
        requestId: string;
        reason: string;
        message: string;
        expectsReply: boolean;
      };
    };
    state = status.state;
    latestCoordination = status.coordinationRequest;
    if (latestCoordination !== undefined && latestCoordination.requestId !== latestCoordinationId) {
      latestCoordinationId = latestCoordination.requestId;
      progress(
        latestCoordination.expectsReply
          ? `Subagent 正在等待父 Agent 决策：${latestCoordination.message}`
          : `Subagent：${latestCoordination.message}`,
        {
          state,
          agent: startInput.agent,
          stepIndex: startInput.stepIndex,
          coordinationRequest: latestCoordination,
          elapsedMs: Date.now() - startedAt,
        },
      );
    }
    if (state !== previousState) {
      previousState = state;
      progress(state === "running" ? "Subagent 正在执行。" : `Subagent 状态：${state}`, {
        state,
        agent: startInput.agent,
        stepIndex: startInput.stepIndex,
        elapsedMs: Date.now() - startedAt,
      });
    }
  }
  if (state === "blocked" && latestCoordination?.expectsReply === true) {
    blockedCloudResults.set(started.providerJobId, {
      stepIndex: startInput.stepIndex,
      requestId: latestCoordination.requestId,
      reason: latestCoordination.reason,
      message: latestCoordination.message,
    });
    return {
      providerJobId: started.providerJobId,
      state: "blocked",
      blockingJobId: latestCoordination.requestId,
      failureMessage: latestCoordination.message,
    };
  }
  try {
    const result = (await request("result", { providerJobId: started.providerJobId })) as Record<
      string,
      unknown
    >;
    if (typeof result.output === "string" && result.output.trim() !== "") {
      completedCloudResults.set(started.providerJobId, {
        stepIndex: startInput.stepIndex,
        output: result.output.trim(),
      });
    }
    if (result.state !== "completed") {
      failedCloudResults.set(started.providerJobId, {
        stepIndex: startInput.stepIndex,
        state: typeof result.state === "string" ? result.state : "failed",
        message:
          typeof result.failureMessage === "string" && result.failureMessage.trim() !== ""
            ? result.failureMessage.trim()
            : `Subagent ended in state ${String(result.state ?? "failed")}.`,
      });
    }
    progress("Subagent 已结束。", {
      state: result.state,
      agent: startInput.agent,
      stepIndex: startInput.stepIndex,
      elapsedMs: Date.now() - startedAt,
    });
    return result;
  } finally {
    activeProviderJobs.delete(started.providerJobId);
  }
}

async function startShimBridge(socketPath: string): Promise<Server> {
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const cloudWait = waitForCloudResult(parseChildInvocation(JSON.parse(line)));
      activeCloudWaits.add(cloudWait);
      void cloudWait
        .then((result) => socket.end(`${JSON.stringify(result)}\n`))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          failedCloudResults.set(`bridge-${randomUUID()}`, {
            stepIndex: 0,
            state: "failed",
            message,
          });
          socket.end(
            `${JSON.stringify({
              state: "failed",
              failureMessage: message,
            })}\n`,
          );
        })
        .finally(() => activeCloudWaits.delete(cloudWait));
    });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(socketPath, () => {
      server.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });
  return server;
}

async function main(): Promise<void> {
  progress("正在准备 pi-subagents 云端编排器。", { state: "preparing" });
  const directories = prepareAgentDir();
  directoriesForBridge = directories;
  process.env.PI_CODING_AGENT_DIR = directories.agentDir;
  process.env.PI_SUBAGENTS_TEMP_ROOT = directories.stateDir;
  process.env.PI_SUBAGENT_PI_BINARY = directories.shimPath;
  process.env.PI_CLOUD_SUBAGENT_BRIDGE_SOCKET = directories.socketPath;
  const bridge = await startShimBridge(directories.socketPath);
  const extensionSpecifier: string = "pi-subagents";
  const extensionModule = await import(extensionSpecifier);
  const registerPiSubagents = (extensionModule as { default: ExtensionFactory }).default;
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerProvider("pi-cloud-subagent-host", {
    baseUrl: "http://127.0.0.1",
    api: "openai-completions",
    models: [
      {
        id: "orchestrator",
        name: "orchestrator",
        reasoning: false,
        input: ["text"],
        contextWindow: 16_384,
        maxTokens: 1_024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey("pi-cloud-subagent-host", "not-used");
  const model = modelRuntime.getModel("pi-cloud-subagent-host", "orchestrator");
  if (model === undefined) throw new Error("Subagent extension host model was unavailable");
  const sessionManager = SessionManager.create(
    directories.stateDir,
    join(directories.stateDir, "contract-sessions"),
    { id: input.parentSessionId },
  );
  sessionManager.appendMessage({
    role: "user",
    content: "PiCloud owns the parent context in PostgreSQL; fork it through the cloud runner.",
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Cloud provider boundary ready." }],
    api: "openai-completions",
    provider: "pi-cloud",
    model: "provider-adapter",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const loader = new DefaultResourceLoader({
    cwd: directories.stateDir,
    agentDir: directories.agentDir,
    eventBus: createEventBus(),
    extensionFactories: [{ name: "pi-subagents", factory: registerPiSubagents }],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: directories.stateDir,
    agentDir: directories.agentDir,
    modelRuntime,
    model,
    thinkingLevel: "off",
    resourceLoader: loader,
    sessionManager,
    sessionStartEvent: { type: "session_start", reason: "new" },
    noTools: "builtin",
  });
  await session.bindExtensions({ mode: "print" });
  let result: AgentToolResult<unknown>;
  try {
    result = await (async (): Promise<AgentToolResult<unknown>> => {
      const registered = session.extensionRunner
        .getAllRegisteredTools()
        .find((tool) => tool.definition.name === "subagent");
      if (registered === undefined) throw new Error("pi-subagents Tool was unavailable");
      const tool = wrapRegisteredTool(registered, session.extensionRunner);
      if (input.arguments.action === "list") {
        return tool.execute(input.toolCallId, { action: "list" }, abort.signal);
      }
      if (typeof input.arguments.action === "string") {
        throw new Error(
          "Cloud subagent management actions are unavailable across Worker replacement; start a child or workflow instead",
        );
      }
      const requestedScript =
        typeof input.arguments.workflowScript === "string"
          ? input.arguments.workflowScript
          : structuredChildWorkflowScript(input.arguments);
      if (requestedScript === undefined) {
        throw new Error("Cloud subagents require { agent, task } or a pi-subagents workflowScript");
      }
      const {
        agent: _structuredAgent,
        task: _structuredTask,
        resume: _structuredResume,
        ...workflowArguments
      } = input.arguments;
      const argumentsForCloud = {
        ...workflowArguments,
        workflowScript: cloudWorkflowScript(requestedScript, input.arguments.worktree === true),
        async: true,
        mission: false,
        chatProgress: "off",
        worktree: false,
      };
      const launched = await tool.execute(
        input.toolCallId,
        argumentsForCloud,
        abort.signal,
        (partial: AgentToolResult<unknown>) =>
          parentPort!.postMessage({ type: "progress", result: partial }),
      );
      const asyncId =
        typeof launched.details === "object" &&
        launched.details !== null &&
        "asyncId" in launched.details &&
        typeof launched.details.asyncId === "string"
          ? launched.details.asyncId
          : undefined;
      if (asyncId === undefined) return launched;
      const registeredWait = session.extensionRunner
        .getAllRegisteredTools()
        .find((candidate) => candidate.definition.name === "subagent_wait");
      if (registeredWait === undefined) throw new Error("pi-subagents wait Tool was unavailable");
      const waitTool = wrapRegisteredTool(registeredWait, session.extensionRunner);
      const waited = await waitTool.execute(
        `${input.toolCallId}:wait`,
        { id: asyncId, timeoutMs: 300_000 },
        abort.signal,
      );
      // The upstream process watchdog protects a local child process. In
      // PiCloud, a leaf may already be durably admitted and continue on another
      // Worker after that local shim exits. PostgreSQL Child Run settlement is
      // authoritative, so never return an empty parent result while an admitted
      // cloud leaf is still active.
      while (activeCloudWaits.size > 0) {
        await Promise.allSettled([...activeCloudWaits]);
      }
      if (
        completedCloudResults.size === 0 &&
        failedCloudResults.size === 0 &&
        blockedCloudResults.size === 0
      ) {
        return waited;
      }
      const blocked = [...blockedCloudResults.values()].sort(
        (left, right) => left.stepIndex - right.stepIndex,
      );
      if (blocked.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "A cloud Subagent paused for supervisor input.",
                ...blocked.flatMap((request) => [
                  "",
                  `${request.requestId} · ${request.reason}`,
                  request.message,
                  `Reply with subagent_supervisor({ action: \"reply\", replyTo: \"${request.requestId}\", message: \"...\" }).`,
                ]),
              ].join("\n"),
            },
          ],
          details: { state: "blocked", requests: blocked },
        };
      }
      const failed = [...failedCloudResults.values()].sort(
        (left, right) => left.stepIndex - right.stepIndex,
      );
      if (failed.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: failed
                .map((result) => `Subagent ${result.state}: ${result.message}`)
                .join("\n\n"),
            },
          ],
          details: { state: "failed", failures: failed },
        };
      }
      const cloudOutput = [...completedCloudResults.values()]
        .sort((left, right) => left.stepIndex - right.stepIndex)
        .map((result) => result.output)
        .join("\n\n---\n\n")
        .trim();
      return {
        content: [
          {
            type: "text" as const,
            text:
              cloudOutput === ""
                ? "Subagent workflow completed without a text result."
                : `Subagent workflow completed.\n\n${cloudOutput}`,
          },
        ],
        // The upstream launch/wait payload contains Worker-local paths,
        // async registry IDs and follow-up instructions that are invalid after
        // this cloud invocation is disposed. Keep only bounded terminal facts
        // in the model-visible result.
        details: {
          state: "completed",
          childCount: completedCloudResults.size,
        },
      };
    })();
  } finally {
    session.dispose();
    await new Promise<void>((resolvePromise) => bridge.close(() => resolvePromise()));
    rmSync(directories.agentDir, { recursive: true, force: true });
    rmSync(directories.stateDir, { recursive: true, force: true });
  }
  parentPort!.postMessage({ type: "result", result });
}

void main().catch((error: unknown) => {
  parentPort!.postMessage({
    type: "failure",
    message: error instanceof Error ? error.message : String(error),
  });
});
