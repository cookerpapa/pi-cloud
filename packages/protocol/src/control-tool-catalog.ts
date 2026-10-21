import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { isControlToolName } from "./control-tools.ts";

export const ControlToolCatalogDefinitionSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
    description: Type.String({ minLength: 1 }),
    parameters: Type.Record(Type.String(), Type.Unknown()),
    requiresEnvironment: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ControlToolCatalogDefinition = Static<typeof ControlToolCatalogDefinitionSchema>;
export const ControlToolCatalogSchema = Type.Object(
  {
    version: Type.Literal(1),
    revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    tools: Type.Array(ControlToolCatalogDefinitionSchema),
  },
  { additionalProperties: false },
);
export type ControlToolCatalog = Static<typeof ControlToolCatalogSchema>;
export interface ControlToolCatalogSource {
  read(): ControlToolCatalog;
  subscribe(listener: () => void): () => void;
}
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
export function parseControlToolCatalog(value: unknown): ControlToolCatalog {
  if (!Value.Check(ControlToolCatalogSchema, value))
    throw new TypeError("Invalid control Tool catalog");
  const names = new Set<string>();
  for (const tool of value.tools) {
    if (
      names.has(tool.name) ||
      isControlToolName(tool.name) ||
      ["read", "write", "edit", "bash", "workflow"].includes(tool.name) ||
      tool.parameters.type !== "object"
    )
      throw new TypeError("Control Tool catalog conflicts with a fixed native adapter or schema");
    names.add(tool.name);
  }
  const snapshot = structuredClone(value);
  freeze(snapshot);
  return snapshot;
}

/** Intent decoding stays independent of which implementations are installed. */
export function isControlDispatchToolName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}
