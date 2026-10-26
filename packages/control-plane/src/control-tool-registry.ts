import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import {
  parseControlToolCatalog,
  parseToolResultPayload,
  assertSubagentResultBudget,
  type ControlToolCatalog,
  type ControlToolCatalogDefinition,
  type ControlToolCatalogSource,
} from "@pi-cloud/protocol";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
import type { ControlToolOutcome } from "./control-tool-dispatcher.ts";

type Result = Extract<ControlToolOutcome, { result: unknown }>;
export type RegisteredControlTool = {
  definition: ControlToolCatalogDefinition;
  /** Non-replayable external effects require ordered dispatch admission. */
  replay?: "never";
  execute(
    command: AcceptedControlToolCommand,
    current: () => boolean,
    signal?: AbortSignal,
  ): Promise<Result>;
};

export function controlToolCatalog(
  tools: readonly ControlToolCatalogDefinition[],
): ControlToolCatalog {
  const definitions = JSON.parse(
    JSON.stringify([...tools].sort((a, b) => a.name.localeCompare(b.name))),
  ) as ControlToolCatalogDefinition[];
  return parseControlToolCatalog({
    version: 3,
    revision: createHash("sha256").update(JSON.stringify(definitions)).digest("hex"),
    tools: definitions,
  });
}

/** Definitions and executable admission share one owner; accepted handlers keep their reference. */
export class ControlToolRegistry implements ControlToolCatalogSource {
  readonly #tools = new Map<string, RegisteredControlTool>();
  readonly #listeners = new Set<() => void>();
  #snapshot = controlToolCatalog([]);
  read(): ControlToolCatalog {
    return this.#snapshot;
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  register(tool: RegisteredControlTool): () => void {
    const name = tool.definition.name;
    if (this.#tools.has(name)) throw new Error("Control Tool is already registered");
    const snapshot = controlToolCatalog(
      [...this.#tools.values()].map((entry) => entry.definition).concat(tool.definition),
    );
    const registered = {
      definition: snapshot.tools.find((definition) => definition.name === name)!,
      execute: tool.execute,
      ...(tool.replay ? { replay: tool.replay } : {}),
    };
    this.#tools.set(name, registered);
    this.#publish(snapshot);
    return () => {
      if (this.#tools.get(name) !== registered) return;
      this.#tools.delete(name);
      this.#publish(controlToolCatalog([...this.#tools.values()].map((entry) => entry.definition)));
    };
  }
  #publish(snapshot: ControlToolCatalog): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
  replayable(name: string): boolean {
    return this.#tools.get(name)?.replay !== "never";
  }
  async execute(
    command: AcceptedControlToolCommand,
    current: () => boolean,
    signal?: AbortSignal,
  ): Promise<Result> {
    const tool = this.#tools.get(command.toolName);
    if (!tool || !current())
      return {
        isError: true,
        result: {
          content: [
            {
              type: "text",
              text: `tool_unavailable: ${command.toolName} is not accepting new invocations.`,
            },
          ],
        },
      };
    if (!Value.Check(tool.definition.parameters as TSchema, command.arguments))
      return {
        isError: true,
        result: {
          content: [
            {
              type: "text",
              text: `invalid_arguments: ${command.toolName} does not accept these arguments.`,
            },
          ],
        },
      };
    const outcome = await tool.execute(command, current, signal);
    try {
      const { result } = parseToolResultPayload({
        toolName: command.toolName,
        toolCallId: command.nativeCallId,
        isError: outcome.isError ?? false,
        result: outcome.result,
      });
      assertSubagentResultBudget(
        result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      );
      if (result.details !== undefined) assertSubagentResultBudget(result.details);
      if (result.diagnostics !== undefined) assertSubagentResultBudget(result.diagnostics);
      return outcome;
    } catch {
      // A completed handler must not run again merely because its reply cannot be delivered.
      return {
        isError: true,
        result: {
          content: [
            {
              type: "text",
              text: "tool_result_unavailable: The Tool returned an invalid or oversized result. Its effects may already have occurred; inspect them before repeating it.",
            },
          ],
        },
      };
    }
  }
}
