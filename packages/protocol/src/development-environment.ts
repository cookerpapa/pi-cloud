import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { AgentWorkspaceSeedSchema } from "./agent-runtime.ts";
import { EnvironmentRuntimeSnapshotSchema } from "./environment.ts";
import { UuidSchema } from "./protocol-primitives.ts";
import { DevelopmentEnvironmentProfileKeySchema } from "./development-environment-profile.ts";
export {
  DEFAULT_EXCLUSIVE_WORKING_DIRECTORY,
  DEVELOPMENT_ENVIRONMENT_PROFILES,
  DevelopmentEnvironmentProfileKeySchema,
  type DevelopmentEnvironmentProfileKey,
} from "./development-environment-profile.ts";

export const TOOL_BROKER_DEVELOPMENT_ENVIRONMENT_PATH =
  "/internal/v1/development-environments" as const;
export const TOOL_BROKER_DEVELOPMENT_ENVIRONMENT_TERMINAL_PATH =
  "/internal/v1/development-environment-terminal" as const;

export const DevelopmentEnvironmentBrokerStateSchema = Type.Union([
  Type.Literal("provisioning"),
  Type.Literal("running"),
  Type.Literal("paused"),
  Type.Literal("releasing"),
  Type.Literal("released"),
  Type.Literal("failed"),
  Type.Literal("unknown"),
]);

export const DevelopmentEnvironmentProvisionRequestSchema = Type.Object(
  {
    developmentEnvironmentProtocolVersion: Type.Literal(1),
    type: Type.Literal("development_environment.provision"),
    requestId: UuidSchema,
    environmentId: UuidSchema,
    tenantId: UuidSchema,
    userId: UuidSchema,
    projectId: UuidSchema,
    workspaceId: UuidSchema,
    generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    profileKey: DevelopmentEnvironmentProfileKeySchema,
    environment: EnvironmentRuntimeSnapshotSchema,
    workspaceSeed: AgentWorkspaceSeedSchema,
  },
  { additionalProperties: false },
);

export const DevelopmentEnvironmentLifecycleRequestSchema = Type.Object(
  {
    developmentEnvironmentProtocolVersion: Type.Literal(1),
    type: Type.Literal("development_environment.lifecycle"),
    requestId: UuidSchema,
    environmentId: UuidSchema,
    tenantId: UuidSchema,
    userId: UuidSchema,
    action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("release")]),
  },
  { additionalProperties: false },
);

export const DevelopmentEnvironmentDirectoryRequestSchema = Type.Object(
  {
    developmentEnvironmentProtocolVersion: Type.Literal(1),
    type: Type.Literal("development_environment.directory"),
    requestId: UuidSchema,
    environmentId: UuidSchema,
    tenantId: UuidSchema,
    userId: UuidSchema,
    path: Type.String({ minLength: 1, maxLength: 4_096, pattern: "^/" }),
  },
  { additionalProperties: false },
);

const GuestDirectoryNameSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: "^(?!\\.{1,2}$)(?!\\s)(?!.*\\s$)[^/\\u0000-\\u001f\\u007f]+$",
});

export const CreateDevelopmentEnvironmentDirectoryRequestSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4_096, pattern: "^/" }),
    name: GuestDirectoryNameSchema,
  },
  { additionalProperties: false },
);

export const DevelopmentEnvironmentCreateDirectoryRequestSchema = Type.Object(
  {
    developmentEnvironmentProtocolVersion: Type.Literal(1),
    type: Type.Literal("development_environment.create_directory"),
    requestId: UuidSchema,
    environmentId: UuidSchema,
    tenantId: UuidSchema,
    userId: UuidSchema,
    path: Type.String({ minLength: 1, maxLength: 4_096, pattern: "^/" }),
    name: GuestDirectoryNameSchema,
  },
  { additionalProperties: false },
);

export const DevelopmentEnvironmentDirectoryEntrySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 255 }),
    path: Type.String({ minLength: 1, maxLength: 4_096, pattern: "^/" }),
    kind: Type.Union([
      Type.Literal("directory"),
      Type.Literal("file"),
      Type.Literal("symlink"),
      Type.Literal("other"),
    ]),
    sizeBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  },
  { additionalProperties: false },
);

export const DevelopmentEnvironmentDirectoryResourceSchema = Type.Object(
  {
    environmentId: UuidSchema,
    path: Type.String({ minLength: 1, maxLength: 4_096, pattern: "^/" }),
    entries: Type.Array(DevelopmentEnvironmentDirectoryEntrySchema, { maxItems: 1_000 }),
  },
  { additionalProperties: false },
);

export const DevelopmentEnvironmentBrokerRequestSchema = Type.Union([
  DevelopmentEnvironmentProvisionRequestSchema,
  DevelopmentEnvironmentLifecycleRequestSchema,
  DevelopmentEnvironmentDirectoryRequestSchema,
  DevelopmentEnvironmentCreateDirectoryRequestSchema,
]);

export const DevelopmentEnvironmentBrokerResponseSchema = Type.Union([
  Type.Object(
    {
      developmentEnvironmentProtocolVersion: Type.Literal(1),
      type: Type.Literal("development_environment.state"),
      requestId: UuidSchema,
      environmentId: UuidSchema,
      state: DevelopmentEnvironmentBrokerStateSchema,
      ipAddress: Type.Optional(Type.String({ minLength: 7, maxLength: 45 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      developmentEnvironmentProtocolVersion: Type.Literal(1),
      type: Type.Literal("development_environment.directory"),
      requestId: UuidSchema,
      ...DevelopmentEnvironmentDirectoryResourceSchema.properties,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      developmentEnvironmentProtocolVersion: Type.Literal(1),
      type: Type.Literal("development_environment.owner_redirect"),
      requestId: UuidSchema,
      ownerBaseUrl: Type.String({ minLength: 8, maxLength: 2_048 }),
    },
    { additionalProperties: false },
  ),
]);

export const DevelopmentEnvironmentTerminalOpenRequestSchema = Type.Object(
  {
    developmentEnvironmentProtocolVersion: Type.Literal(1),
    type: Type.Literal("development_environment_terminal.open"),
    requestId: UuidSchema,
    environmentId: UuidSchema,
    tenantId: UuidSchema,
    userId: UuidSchema,
    rows: Type.Integer({ minimum: 2, maximum: 512 }),
    cols: Type.Integer({ minimum: 2, maximum: 512 }),
  },
  { additionalProperties: false },
);

export type DevelopmentEnvironmentProvisionRequest = Static<
  typeof DevelopmentEnvironmentProvisionRequestSchema
>;
export type DevelopmentEnvironmentLifecycleRequest = Static<
  typeof DevelopmentEnvironmentLifecycleRequestSchema
>;
export type DevelopmentEnvironmentDirectoryRequest = Static<
  typeof DevelopmentEnvironmentDirectoryRequestSchema
>;
export type CreateDevelopmentEnvironmentDirectoryRequest = Static<
  typeof CreateDevelopmentEnvironmentDirectoryRequestSchema
>;
export type DevelopmentEnvironmentCreateDirectoryRequest = Static<
  typeof DevelopmentEnvironmentCreateDirectoryRequestSchema
>;
export type DevelopmentEnvironmentDirectoryResource = Static<
  typeof DevelopmentEnvironmentDirectoryResourceSchema
>;
export type DevelopmentEnvironmentDirectoryEntry = Static<
  typeof DevelopmentEnvironmentDirectoryEntrySchema
>;
export type DevelopmentEnvironmentBrokerRequest = Static<
  typeof DevelopmentEnvironmentBrokerRequestSchema
>;
export type DevelopmentEnvironmentBrokerResponse = Static<
  typeof DevelopmentEnvironmentBrokerResponseSchema
>;
export type DevelopmentEnvironmentTerminalOpenRequest = Static<
  typeof DevelopmentEnvironmentTerminalOpenRequestSchema
>;

export class DevelopmentEnvironmentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevelopmentEnvironmentProtocolError";
  }
}

function parse<Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  label: string,
): Static<Schema> {
  if (!Value.Check(schema, value)) {
    const issues = [...Value.Errors(schema, value)].slice(0, 6);
    throw new DevelopmentEnvironmentProtocolError(
      `${label} failed validation: ${
        issues.map((issue) => `${issue.instancePath || "/"}: ${issue.message}`).join("; ") ||
        "invalid value"
      }; keys=${
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? Object.keys(value).sort().join(",")
          : "non-object"
      }`,
    );
  }
  return value as Static<Schema>;
}

export function parseDevelopmentEnvironmentBrokerRequest(
  value: unknown,
): DevelopmentEnvironmentBrokerRequest {
  return parse(DevelopmentEnvironmentBrokerRequestSchema, value, "development environment request");
}

export function parseDevelopmentEnvironmentBrokerResponse(
  value: unknown,
): DevelopmentEnvironmentBrokerResponse {
  return parse(
    DevelopmentEnvironmentBrokerResponseSchema,
    value,
    "development environment response",
  );
}

export function parseDevelopmentEnvironmentTerminalOpenRequest(
  value: unknown,
): DevelopmentEnvironmentTerminalOpenRequest {
  return parse(
    DevelopmentEnvironmentTerminalOpenRequestSchema,
    value,
    "development environment terminal request",
  );
}

export function parseDevelopmentEnvironmentDirectoryResource(
  value: unknown,
): DevelopmentEnvironmentDirectoryResource {
  return parse(
    DevelopmentEnvironmentDirectoryResourceSchema,
    value,
    "development environment directory",
  );
}

export function parseCreateDevelopmentEnvironmentDirectoryRequest(
  value: unknown,
): CreateDevelopmentEnvironmentDirectoryRequest {
  return parse(
    CreateDevelopmentEnvironmentDirectoryRequestSchema,
    value,
    "create development environment directory request",
  );
}
