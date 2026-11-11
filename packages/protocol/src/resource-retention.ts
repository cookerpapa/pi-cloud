import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema } from "./protocol-primitives.ts";

export const RESOURCE_RETENTION_PATH = "/internal/v1/resource-retention";
export const RESOURCE_RETENTION_BATCH_SIZE = 256;
export const PhysicalResourceUseSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("workspace"), Type.Literal("terminal")]),
    tenantId: UuidSchema,
    id: UuidSchema,
    observedAt: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
export type PhysicalResourceUse = Static<typeof PhysicalResourceUseSchema>;
const request = Type.Object(
  { uses: Type.Array(PhysicalResourceUseSchema, { maxItems: RESOURCE_RETENTION_BATCH_SIZE }) },
  { additionalProperties: false },
);
export function parseResourceRetention(value: unknown): { uses: PhysicalResourceUse[] } {
  if (!Value.Check(request, value)) throw new Error("Invalid resource retention request");
  return value;
}
