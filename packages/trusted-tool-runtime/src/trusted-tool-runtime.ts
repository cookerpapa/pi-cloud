import type { Database } from "@pi-cloud/database";
import type { ExecuteTurnCommandMessage, SubagentControlRequest } from "@pi-cloud/protocol";
import {
  createCloudSubagentTool,
  validateSubagentTask,
  validateSubagentControl,
  type CloudSubagentToolRuntime,
  type SubagentControlClient,
  type SubagentTask,
  type TrustedAgentTool,
  type WorkflowExecutor,
  type WorkflowHostCall,
} from "@pi-cloud/sandbox-supervisor";
import type { Kysely } from "kysely";
import {
  PostgresSubagentJobProvider,
  type NativeSubagentLanes,
  type CloudSubagentTreePolicy,
} from "./postgres-subagent-job-provider.ts";
import {
  createCloudContactSupervisorTool,
  createCloudSubagentSupervisorTool,
} from "./subagent-supervisor-tools.ts";
import { createCloudPreviewTool } from "./postgres-preview-tool.ts";

export type WorkflowCall = WorkflowHostCall;
export type TrustedToolRunContext = Readonly<{
  command: ExecuteTurnCommandMessage;
  refreshServices(): Promise<void>;
  executeWorkflow?: WorkflowExecutor;
}>;
export interface TrustedToolRuntime {
  create(context: TrustedToolRunContext): Promise<readonly TrustedAgentTool[]>;
}
export type PostgresTrustedToolRuntimeOptions = Readonly<{
  database: Kysely<Database>;
  nativeLanes: NativeSubagentLanes;
  control: SubagentControlClient;
  treePolicy?: CloudSubagentTreePolicy;
}>;
function trusted(
  executionPlane: TrustedAgentTool["executionPlane"],
  tool: TrustedAgentTool["tool"],
): TrustedAgentTool {
  return { executionPlane, tool };
}

/** Worker composition: native context and log publication, never child admission. */
export class PostgresTrustedToolRuntime implements TrustedToolRuntime {
  readonly #jobs: PostgresSubagentJobProvider;
  constructor(readonly options: PostgresTrustedToolRuntimeOptions) {
    this.#jobs = new PostgresSubagentJobProvider(options);
  }
  async create(context: TrustedToolRunContext): Promise<readonly TrustedAgentTool[]> {
    const { command, refreshServices } = context;
    const scope = command.payload;
    const requests = new Map<
      string,
      { specification: string; published: Promise<void>; promise: Promise<Record<string, unknown>> }
    >();
    const control = async (
      toolCallId: string,
      request: SubagentControlRequest,
      signal?: AbortSignal,
      onPublished?: () => void,
    ) => {
      if ("target" in request)
        await requests.get(JSON.stringify([toolCallId, request.target]))?.published;
      return this.options.control.request({
        executionReference: scope.executionReference,
        toolCallId,
        workflowId: toolCallId,
        request,
        ...(signal ? { signal } : {}),
        ...(onPublished ? { onPublished } : {}),
      });
    };
    const preview = trusted(
      "platform",
      createCloudPreviewTool({
        refreshServices,
        database: this.options.database,
        tenantId: scope.tenantId,
        sessionId: scope.sessionId,
      }),
    );
    const tree =
      scope.sessionKind === "subagent"
        ? await this.#jobs.treeContext(scope.tenantId, scope.runId)
        : undefined;
    const contact = tree
      ? trusted("orchestration", createCloudContactSupervisorTool(control))
      : undefined;
    const supervisor = trusted("orchestration", createCloudSubagentSupervisorTool(control));
    const tools = [preview, ...(contact ? [contact] : [])];
    if (tree && !tree.canSpawnChildren) return [...tools, supervisor];

    const run: CloudSubagentToolRuntime["run"] = (toolCallId, task, signal) => {
      validateSubagentTask(task);
      const key = JSON.stringify([toolCallId, task.key]);
      const specification = JSON.stringify({
        task: task.task,
        context: task.context ?? "fresh",
        sandbox: task.sandbox ?? "shared",
        cwd: task.cwd ?? null,
        tools: task.tools?.slice().sort() ?? null,
      });
      const previous = requests.get(key);
      if (previous) {
        if (previous.specification !== specification)
          return Promise.reject(new Error("Workflow key reused with different task arguments"));
        return previous.promise;
      }
      const anchor = this.options.nativeLanes.childAnchor(
        scope.executionReference,
        task.context === "branch",
      );
      let published!: () => void, failed!: (error: unknown) => void;
      const publication = new Promise<void>((resolve, reject) => {
        published = resolve;
        failed = reject;
      });
      void publication.catch(() => {});
      const promise = (async () => {
        const started = await control(
          toolCallId,
          {
            action: "start",
            key: task.key,
            task: task.task,
            context: task.context ?? "fresh",
            sandbox: task.tools?.length === 0 ? "none" : (task.sandbox ?? "shared"),
            ...(task.cwd !== undefined ? { cwd: task.cwd } : {}),
            anchor,
            ...(task.tools ? { tools: task.tools } : {}),
          },
          signal,
          published,
        );
        if (typeof started.executionId !== "string")
          throw new Error("Subagent admission did not return an execution identity");
        return control(toolCallId, { action: "wait", target: started.executionId }, signal);
      })();
      void promise.catch(failed);
      requests.set(key, { specification, published: publication, promise });
      return promise;
    };
    const runtime: CloudSubagentToolRuntime = {
      run,
      control,
      workflow: async (toolCallId, script, signal, onUpdate) => {
        if (!context.executeWorkflow) throw new Error("Isolated workflow execution is unavailable");
        return context.executeWorkflow(
          toolCallId,
          script,
          async (method, args, callSignal) => {
            if (method === "run") {
              if (typeof args.key !== "string" || !args.task || typeof args.task !== "object")
                throw new Error("runs.run requires a key and task specification");
              return run(
                toolCallId,
                { ...args.task, key: args.key } as SubagentTask,
                callSignal ?? signal,
              );
            }
            if (!["status", "wait", "cancel", "send"].includes(method))
              throw new Error("Unknown workflow control method");
            return control(
              toolCallId,
              validateSubagentControl({ ...args, action: method }),
              callSignal ?? signal,
            );
          },
          signal,
          onUpdate,
        );
      },
    };
    return [...tools, trusted("orchestration", createCloudSubagentTool(runtime)), supervisor];
  }
}
