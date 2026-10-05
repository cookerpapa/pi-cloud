import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { MIN_TOOL_EXECUTION_TIMEOUT_MS, MAX_TOOL_EXECUTION_TIMEOUT_MS } from "@pi-cloud/protocol";

/** The same code-owned schemas drive Pi validation and the remote adapter.
 * No environment or effect port is created while constructing definitions. */
export function fixedRemoteToolDefinitions(): Omit<ToolRegistration, "execute" | "replay">[] {
  const bash = createBashTool();
  return [createReadTool(), createWriteTool(), createEditTool(), bash].map(
    ({ execute: _execute, replay: _replay, ...tool }) => ({
      ...tool,
      executionMode: tool.name === "read" ? "parallel" : "sequential",
      parameters:
        tool.name === "bash"
          ? {
              ...tool.parameters,
              additionalProperties: false,
              properties: {
                ...tool.parameters.properties,
                timeout: {
                  ...bash.parameters.properties.timeout,
                  minimum: MIN_TOOL_EXECUTION_TIMEOUT_MS / 1000,
                  maximum: MAX_TOOL_EXECUTION_TIMEOUT_MS / 1000,
                },
              },
            }
          : tool.name === "read"
            ? {
                ...tool.parameters,
                properties: {
                  ...tool.parameters.properties,
                  detail: {
                    type: "string",
                    enum: ["high", "original"],
                    description:
                      "Image detail: high (default) or original for fine visual inspection.",
                  },
                },
              }
            : tool.parameters,
      ...(tool.name === "bash"
        ? {
            description:
              "Execute a Bash command in the selected working directory. Output is limited to the last 2000 lines or 50 KiB; omitted output is not archived. Only command and timeout are accepted. Use cd inside command to change directory. Timeout defaults to 300 seconds (maximum 300). Detach long-running services and redirect stdin, stdout and stderr.",
          }
        : {}),
    }),
  );
}
