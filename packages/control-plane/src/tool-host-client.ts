import { Agent, fetch as internalFetch } from "undici";
import {
  MAX_TOOL_RESPONSE_BYTES,
  parsePackedToolResultPayload,
  type ImagePacked,
  type ToolResultPayload,
  type ToolCatalogPublication,
} from "@pi-cloud/protocol";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
import type { ControlToolOutcome } from "./control-tool-dispatcher.ts";

export const TOOL_HOST_EXECUTE_PATH = "/internal/v1/tools/execute";
export const TOOL_HOST_ACTIVATE_PATH = "/internal/v1/tools/activate";
export const TOOL_HOST_MANIFEST_PATH = "/internal/v1/tools/manifest";
export const TOOL_HOST_DRAIN_PATH = "/internal/v1/tools/drain";

/** One request, one selected implementation. A transport loss is not retried:
 * unlike a definite refusal it cannot establish that the handler did not run. */
export class ToolHostClient {
  readonly #dispatcher = new Agent({
    connect: { timeout: 5000 },
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  constructor(
    readonly options: {
      baseUrl: string;
      token: string;
      catalog(): ToolCatalogPublication | undefined;
    },
  ) {}

  async execute(
    command: AcceptedControlToolCommand,
    current: () => boolean,
    signal?: AbortSignal,
  ): Promise<ControlToolOutcome> {
    const catalog = this.options.catalog();
    const selected = command.implementation;
    const failure = (message: string): ControlToolOutcome => ({
      isError: true,
      result: { content: [{ type: "text", text: message }] },
    });
    if (!current() || signal?.aborted || !selected)
      return failure("tool_unavailable: The tool catalog or execution owner is unavailable.");
    if (catalog?.generation !== selected.generation || catalog?.releaseId !== selected.releaseId)
      return failure(
        "tool_unavailable: The accepted tool implementation has been replaced. This invocation was not submitted.",
      );
    try {
      const response = await internalFetch(new URL(TOOL_HOST_EXECUTE_PATH, this.options.baseUrl), {
        dispatcher: this.#dispatcher,
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ releaseId: selected.releaseId, command }),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return failure(
          [409, 412, 503].includes(response.status)
            ? "tool_unavailable: The selected tool implementation did not accept this invocation. Refresh the catalog before another call."
            : "tool_result_unknown: The tool host could not confirm this invocation. Inspect effects before repeating it.",
        );
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            bytes += item.value.byteLength;
            if (bytes > MAX_TOOL_RESPONSE_BYTES) throw new Error("Tool host reply is oversized");
            chunks.push(item.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        operationId?: string;
        releaseId?: string;
        result?: ImagePacked<ToolResultPayload>;
      };
      if (body.operationId !== command.operationId || body.releaseId !== selected.releaseId)
        throw new Error("Tool host response identity changed");
      const packed = parsePackedToolResultPayload(body.result);
      if (
        packed.toolCallId !== command.nativeCallId ||
        packed.toolName !==
          (command.replyMode === "hostcall" ? "subagent-control" : command.toolName)
      )
        throw new Error("Tool host response refers to another invocation");
      return { packed };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return failure(
        "tool_result_unknown: The connection to the tool host ended without a confirmed result. This invocation was not resent; inspect effects before repeating it.",
      );
    }
  }
  close(): Promise<void> {
    return this.#dispatcher.destroy();
  }
}
