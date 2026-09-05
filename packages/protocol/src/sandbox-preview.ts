import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema } from "./protocol-primitives.ts";

export const TOOL_BROKER_SANDBOX_PREVIEW_PATH = "/internal/v1/sandbox-preview" as const;
export const PREVIEW_ACCESS_TTL_MS = 15 * 60_000;
export const PREVIEW_SCOPE_HEADER = "x-pi-cloud-preview-scope";
export const SANDBOX_PREVIEW_MINIMUM_PORT = 1_024 as const;
export const SANDBOX_PREVIEW_MAXIMUM_PORT = 65_535 as const;

const SandboxPreviewPortSchema = Type.Union([
  Type.Integer({ minimum: SANDBOX_PREVIEW_MINIMUM_PORT, maximum: 49_982 }),
  Type.Integer({ minimum: 49_985, maximum: 50_004 }),
  Type.Integer({ minimum: 50_006, maximum: SANDBOX_PREVIEW_MAXIMUM_PORT }),
]);

export const SandboxPreviewTargetSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("conversation"), sessionId: UuidSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("development_environment"), environmentId: UuidSchema },
    { additionalProperties: false },
  ),
]);

export const SandboxPreviewConnectionSchema = Type.Object(
  {
    tenantId: UuidSchema,
    userId: UuidSchema,
    workspaceId: UuidSchema,
    target: SandboxPreviewTargetSchema,
    port: SandboxPreviewPortSchema,
    expiresAt: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type SandboxPreviewConnectionRequest = Static<typeof SandboxPreviewConnectionSchema>;
export function parseSandboxPreviewConnection(value: unknown): SandboxPreviewConnectionRequest {
  return parse(SandboxPreviewConnectionSchema, value, "Sandbox preview connection");
}

export class SandboxPreviewProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPreviewProtocolError";
  }
}

function parse<Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  label: string,
): Static<Schema> {
  if (!Value.Check(schema, value)) throw new SandboxPreviewProtocolError(`${label} was invalid`);
  return value as Static<Schema>;
}

export type SandboxPreviewTarget = Static<typeof SandboxPreviewTargetSchema>;
