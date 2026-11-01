import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema } from "./protocol-primitives.ts";

// Import/placement transport envelopes, not a per-user storage quota.
export const SKILL_PACKAGE_BYTES = 16 * 1024 * 1024;
export const SKILL_ENVELOPE_BYTES = 24 * 1024 * 1024;
const closed = { additionalProperties: false } as const;
export const SkillRequirementsSchema = Type.Object(
  {
    tools: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }), {
      maxItems: 64,
      uniqueItems: true,
    }),
    runtime: Type.Union([Type.Literal("none"), Type.Literal("linux"), Type.Literal("android")]),
    software: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 64 }),
  },
  closed,
);
export type SkillRequirements = Static<typeof SkillRequirementsSchema>;
export const SkillFileSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 512 }),
    base64: Type.String({ maxLength: SKILL_ENVELOPE_BYTES }),
  },
  closed,
);
export type SkillFile = Static<typeof SkillFileSchema>;
export const SkillImportSchema = Type.Object(
  {
    packageId: Type.Optional(UuidSchema),
    label: Type.String({ minLength: 1, maxLength: 100 }),
    requirements: SkillRequirementsSchema,
    source: Type.Union([
      Type.Object(
        {
          kind: Type.Literal("files"),
          files: Type.Array(SkillFileSchema, { minItems: 1, maxItems: 512 }),
        },
        closed,
      ),
      Type.Object(
        {
          kind: Type.Literal("github"),
          repository: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }),
          ref: Type.String({ minLength: 1, maxLength: 200 }),
          path: Type.String({ maxLength: 512 }),
        },
        closed,
      ),
    ]),
  },
  closed,
);
export type SkillImport = Static<typeof SkillImportSchema>;
export const SkillScopeSchema = Type.Union([
  Type.Object({ kind: Type.Literal("personal") }, closed),
  Type.Object({ kind: Type.Literal("tenant") }, closed),
  Type.Object({ kind: Type.Literal("project"), projectId: UuidSchema }, closed),
]);
export type SkillScope = Static<typeof SkillScopeSchema>;
export const SkillInstallationChangeSchema = Type.Object(
  {
    scope: SkillScopeSchema,
    versionId: UuidSchema,
    enabled: Type.Boolean(),
    revision: Type.Union([Type.String({ pattern: "^[1-9][0-9]*$" }), Type.Null()]),
  },
  closed,
);
export type SkillInstallationChange = Static<typeof SkillInstallationChangeSchema>;
export const SkillRuntimeMetadataSchema = Type.Object(
  {
    disableModelInvocation: Type.Boolean(),
    requiresWorkspaceFiles: Type.Boolean(),
  },
  closed,
);
export type SkillRuntimeMetadata = Static<typeof SkillRuntimeMetadataSchema>;
export const SkillCatalogEntrySchema = Type.Object(
  {
    versionId: UuidSchema,
    packageId: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 64 }),
    description: Type.String({ minLength: 1, maxLength: 1024 }),
    digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    requirements: SkillRequirementsSchema,
    runtimeMetadata: SkillRuntimeMetadataSchema,
  },
  closed,
);
export const RunSkillCatalogSchema = Type.Array(SkillCatalogEntrySchema);
export type SkillCatalogEntry = Static<typeof SkillCatalogEntrySchema>;
export function parseRunSkillCatalog(value: unknown): SkillCatalogEntry[] {
  if (
    !Value.Check(RunSkillCatalogSchema, value) ||
    new Set(value.map((v) => v.versionId)).size !== value.length
  )
    throw new TypeError("Invalid Run Skill catalog");
  return value;
}
export type SkillVersion = {
  runtimeMetadata: SkillRuntimeMetadata;
  versionId: string;
  packageId: string;
  label: string;
  name: string;
  description: string;
  compatibility: string;
  digest: string;
  byteLength: number;
  requirements: SkillRequirements;
  source:
    | { kind: "files" }
    | { kind: "github"; repository: string; ref: string; path: string; commit: string };
};
export type SkillInstallation = {
  scope: SkillScope;
  versionId: string;
  enabled: boolean;
  revision: string;
};
export type SkillAvailability = {
  state: "available" | "unsupported" | "unverified";
  reasons: string[];
};
export type SkillMarket = {
  packages: {
    packageId: string;
    ownerUserId: string;
    versions: (SkillVersion & { availability: SkillAvailability })[];
    installations: SkillInstallation[];
  }[];
  nextCursor: string | null;
};
export function parseSkill<T>(schema: TSchema, value: unknown): T {
  if (!Value.Check(schema, value)) throw new TypeError("Invalid Skill request");
  return value as T;
}
export const parseSkillImport = (value: unknown) =>
  parseSkill<SkillImport>(SkillImportSchema, value);
export const parseSkillInstallationChange = (value: unknown) =>
  parseSkill<SkillInstallationChange>(SkillInstallationChangeSchema, value);

export function skillAvailability(
  requirements: SkillRequirements,
  capabilities: { runtimes: readonly ("linux" | "android")[]; tools: readonly string[] },
): SkillAvailability {
  const reasons = requirements.tools
    .filter((name) => !capabilities.tools.includes(name))
    .map((name) => `tool:${name}`);
  if (requirements.runtime !== "none" && !capabilities.runtimes.includes(requirements.runtime))
    reasons.push(`runtime:${requirements.runtime}`);
  if (reasons.length) return { state: "unsupported", reasons };
  return requirements.software.length
    ? { state: "unverified", reasons: requirements.software.map((name) => `software:${name}`) }
    : { state: "available", reasons: [] };
}

export const SkillPackageContentSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }),
    files: Type.Array(SkillFileSchema, { minItems: 1, maxItems: 512 }),
    requirements: SkillRequirementsSchema,
  },
  closed,
);
export type SkillPackageContent = Static<typeof SkillPackageContentSchema>;
export function validSkillPath(path: string): boolean {
  return (
    path.length <= 512 &&
    !/[\\\u0000-\u001f:]/.test(path) &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

/** Reading an instruction or resource is an activation; textual references and
 * continuation pages remain storage-only. Resolve against the immutable Run manifest. */
export function skillActivationNeedsWorkspace(
  skill: SkillCatalogEntry,
  args: Record<string, unknown>,
): boolean {
  if (args.action !== "read" || (typeof args.offset === "number" && args.offset > 0)) return false;
  const path = typeof args.path === "string" ? args.path : "SKILL.md";
  return skill.runtimeMetadata.requiresWorkspaceFiles && !path.startsWith("references/");
}

/** Resolve a model-friendly name against the Run's immutable selection. The
 * explicit version reference is needed only to disambiguate duplicate names. */
export function selectRunSkill<T extends SkillCatalogEntry>(
  catalog: readonly T[],
  args: { name?: unknown; versionId?: unknown },
): T {
  const name = typeof args.name === "string" ? args.name : undefined;
  const versionId = typeof args.versionId === "string" ? args.versionId : undefined;
  if (!name && !versionId)
    throw new TypeError("Provide the Skill name from the current available_skills section.");
  const selected = catalog.filter(
    (skill) => (!name || skill.name === name) && (!versionId || skill.versionId === versionId),
  );
  if (selected.length > 1)
    throw new TypeError(
      "Several installed Skills share that name. Use action=list, then provide name and versionId to select one.",
    );
  if (!selected[0])
    throw new TypeError(
      "Skill is not selected for this Run. Use its name from the current available_skills section, not a historical version ID. action=list shows the selected versions.",
    );
  return selected[0];
}
