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
export type SkillVersion = {
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
  runtime: "linux" | "android" | "none",
  tools: readonly string[],
): SkillAvailability {
  const reasons = requirements.tools
    .filter((name) => !tools.includes(name))
    .map((name) => `tool:${name}`);
  if (requirements.runtime !== "none" && requirements.runtime !== runtime)
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
