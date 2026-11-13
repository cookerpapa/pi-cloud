import { TOOL_REPLY_DELIVERY_MARGIN_MS } from "./tool-recovery.ts";
import { Type, type TSchema } from "typebox";
import type { ControlToolCatalogDefinition } from "./control-tool-catalog.ts";
import { ANDROID_OPERATION_TIMEOUT_MS, ANDROID_REPLY_TIMEOUT_MS } from "./android-tools.ts";
import {
  MAX_TOOL_COMMAND_BYTES,
  MAX_TOOL_MUTATION_FILE_BYTES,
  MAX_TOOL_EXECUTION_TIMEOUT_MS,
} from "./tool-sandbox.ts";

export const LOCAL_CAPABILITIES = [
  "local.read",
  "local.write",
  "local.edit",
  "local.bash",
] as const;
const path = Type.String({ minLength: 1, maxLength: 4096 });
const tool = (
  name: string,
  description: string,
  parameters: TSchema,
): ControlToolCatalogDefinition => ({
  name: `local_${name}`,
  description,
  environment: { kind: "target", targetKind: "linux", capabilities: [`local.${name}`] },
  parameters: JSON.parse(JSON.stringify(parameters)),
});
export const localToolDefinitions = (): ControlToolCatalogDefinition[] => [
  tool(
    "read",
    "Read text or images from the explicitly connected local Linux project, mounted at /workspace. This is the user's local environment, separate from the cloud Workspace.",
    Type.Object(
      {
        path,
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
        detail: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("original")])),
      },
      { additionalProperties: false },
    ),
  ),
  tool(
    "write",
    "Write a file in the connected local Linux project at /workspace. This changes the user's local files, not the cloud Workspace.",
    Type.Object(
      { path, content: Type.String({ maxLength: MAX_TOOL_MUTATION_FILE_BYTES }) },
      { additionalProperties: false },
    ),
  ),
  tool(
    "edit",
    "Replace an exact oldText occurrence in a local project file under /workspace. Read the file first.",
    Type.Object(
      {
        path,
        edits: Type.Array(
          Type.Object(
            {
              oldText: Type.String({ maxLength: MAX_TOOL_MUTATION_FILE_BYTES }),
              newText: Type.String({ maxLength: MAX_TOOL_MUTATION_FILE_BYTES }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
      },
      { additionalProperties: false },
    ),
  ),
  tool(
    "bash",
    "Run Bash in the connected local Linux project at /workspace. Output is bounded at source. Background programs remain in this local executor; stopping the executor ends them. Cloud Workspace files are separate.",
    Type.Object(
      {
        command: Type.String({ minLength: 1, maxLength: MAX_TOOL_COMMAND_BYTES }),
        timeout: Type.Optional(
          Type.Number({ minimum: 0.1, maximum: MAX_TOOL_EXECUTION_TIMEOUT_MS / 1000 }),
        ),
      },
      { additionalProperties: false },
    ),
  ),
];

/** Per-operation budgets, never a total Agent Run deadline. */
export function executorToolBudget(name: string, args: Record<string, unknown>) {
  if (!name.startsWith("local_"))
    return { operationMs: ANDROID_OPERATION_TIMEOUT_MS, replyMs: ANDROID_REPLY_TIMEOUT_MS };
  const requested =
    name === "local_bash" && typeof args.timeout === "number"
      ? args.timeout * 1000
      : MAX_TOOL_EXECUTION_TIMEOUT_MS;
  const operationMs = Math.max(100, Math.min(MAX_TOOL_EXECUTION_TIMEOUT_MS, Math.ceil(requested)));
  return { operationMs, replyMs: operationMs + TOOL_REPLY_DELIVERY_MARGIN_MS };
}
