import { Value } from "typebox/value";
import { Type, type Static } from "typebox";
import { ControlToolCatalogSchema, parseControlToolCatalog } from "./control-tool-catalog.ts";

export const TOOL_CATALOG_TOPIC = "pi-cloud.tool-catalog.v1";
export const TOOL_CATALOG_KEY = "platform";
export const MAX_TOOL_CATALOG_BYTES = 1_048_576;

export const ToolCatalogPublicationSchema = Type.Object(
  {
    version: Type.Literal(1),
    scope: Type.Literal(TOOL_CATALOG_KEY),
    generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    releaseId: Type.String({ minLength: 1, maxLength: 256 }),
    catalog: ControlToolCatalogSchema,
    replayable: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }), {
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

export type ToolCatalogPublication = Static<typeof ToolCatalogPublicationSchema>;

export function parseToolCatalogPublication(value: unknown): ToolCatalogPublication {
  if (!Value.Check(ToolCatalogPublicationSchema, value))
    throw new Error("Invalid tool catalog publication");
  parseControlToolCatalog(value.catalog);
  const names = new Set(value.catalog.tools.map((tool) => tool.name));
  if (value.replayable.some((name) => !names.has(name)))
    throw new Error("Catalog replay policy names an absent Tool");
  return value;
}
