import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { DevelopmentEnvironmentProfileKeySchema } from "./development-environment-profile.ts";
import { UuidSchema } from "./protocol-primitives.ts";

const name = Type.String({ minLength: 1, maxLength: 128, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const id = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_.-]+$" });
const endpoint = Type.String({ minLength: 1, maxLength: 2048 });
const secret = Type.String({ minLength: 1, maxLength: 4096 });
const profiles = Type.Object(
  { starter: name, standard: name, performance: name },
  { additionalProperties: false },
);

export const ResourceBackendSelectionSchema = Type.Object(
  { id, templateId: id, revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) },
  { additionalProperties: false },
);
export type ResourceBackendSelection = Static<typeof ResourceBackendSelectionSchema>;

export const ResourceBackendConfigurationSchema = Type.Object(
  {
    storage: Type.Object(
      { url: endpoint, token: secret, poolId: Type.Optional(name) },
      { additionalProperties: false },
    ),
    webProxy: Type.Object(
      {
        host: name,
        port: Type.Integer({ minimum: 1, maximum: 65535 }),
        directPrivateCidrs: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 256 }),
      },
      { additionalProperties: false },
    ),
    compute: Type.Union([
      Type.Object(
        {
          provider: Type.Literal("cubesandbox"),
          apiUrl: endpoint,
          apiKey: secret,
          proxyNodeIp: name,
          proxyPort: Type.Integer({ minimum: 1, maximum: 65535 }),
          proxyScheme: Type.Union([Type.Literal("http"), Type.Literal("https")]),
          sandboxDomain: name,
          lifecycleRedisUrl: Type.Optional(endpoint),
          lifecycleRedisPassword: Type.Optional(secret),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        { provider: Type.Literal("boxlite"), url: endpoint, nodeId: name, token: secret },
        { additionalProperties: false },
      ),
    ]),
    templates: Type.Array(
      Type.Object(
        {
          id,
          name,
          operatingSystem: name,
          imageRevision: name,
          elasticTemplateId: name,
          profiles,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 32 },
    ),
  },
  { additionalProperties: false },
);

export const PutResourceBackendSchema = Type.Object(
  {
    id,
    name,
    location: name,
    expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    state: Type.Union([Type.Literal("active"), Type.Literal("draining"), Type.Literal("disabled")]),
    configuration: Type.Optional(ResourceBackendConfigurationSchema),
  },
  { additionalProperties: false },
);
export type ResourceBackendConfiguration = Static<typeof ResourceBackendConfigurationSchema>;
export type PutResourceBackend = Static<typeof PutResourceBackendSchema>;
export type ResourceBackendResource = {
  id: string;
  name: string;
  location: string;
  revision: number;
  state: "active" | "draining" | "disabled";
  provider: "cubesandbox" | "boxlite";
  templates: readonly {
    id: string;
    name: string;
    operatingSystem: string;
    imageRevision: string;
    profiles: readonly Static<typeof DevelopmentEnvironmentProfileKeySchema>[];
  }[];
  capabilities: { kind: "linux"; workspace: "independent-volume"; terminal: true; preview: true };
};
export const RESOURCE_BACKENDS_INTERNAL_PATH = "/internal/v1/resource-backends";
const RegisterDeviceSchema = Type.Object(
  { targetId: UuidSchema, name, endpoint },
  { additionalProperties: false },
);
export type RegisterResourceDevice = Static<typeof RegisterDeviceSchema>;
const RegisterDeviceRequestSchema = Type.Object(
  { tenantId: UuidSchema, device: RegisterDeviceSchema },
  { additionalProperties: false },
);
export type RegisterResourceDeviceRequest = Static<typeof RegisterDeviceRequestSchema>;
export function parseRegisterResourceDeviceRequest(value: unknown): RegisterResourceDeviceRequest {
  if (!Value.Check(RegisterDeviceRequestSchema, value))
    throw new TypeError("Invalid device organization or registration");
  parseRegisterResourceDevice(value.device);
  return value;
}
export function parseRegisterResourceDevice(value: unknown): RegisterResourceDevice {
  if (!Value.Check(RegisterDeviceSchema, value)) throw new TypeError("Invalid device registration");
  const url = new URL(value.endpoint);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new TypeError("Use a device endpoint origin");
  return { ...value, endpoint: url.origin };
}
export function parsePutResourceBackend(value: unknown): PutResourceBackend {
  if (!Value.Check(PutResourceBackendSchema, value))
    throw new TypeError("Invalid resource backend configuration");
  if (value.configuration) parseResourceBackendConfiguration(value.configuration);
  return value;
}
export function parseResourceBackendConfiguration(value: unknown): ResourceBackendConfiguration {
  if (!Value.Check(ResourceBackendConfigurationSchema, value))
    throw new TypeError("Invalid resource backend configuration");
  const urls = [
    value.storage.url,
    value.compute.provider === "boxlite" ? value.compute.url : value.compute.apiUrl,
  ];
  for (const address of urls) {
    const url = new URL(address);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new TypeError("Invalid resource backend endpoint");
  }
  if (new Set(value.templates.map((t) => t.id)).size !== value.templates.length)
    throw new TypeError("Duplicate backend template identity");
  return value;
}
