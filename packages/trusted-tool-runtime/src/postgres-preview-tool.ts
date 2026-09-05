import type { Database } from "@pi-cloud/database";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Kysely } from "kysely";

const PreviewToolSchema = Type.Object(
  {
    port: Type.Integer({ minimum: 1_024, maximum: 65_535 }),
    path: Type.Optional(
      Type.String({ minLength: 1, maxLength: 2_048, pattern: "^/[^\\u0000-\\u001f\\u007f ]*$" }),
    ),
  },
  { additionalProperties: false },
);

export function createCloudPreviewTool(options: {
  database: Kysely<Database>;
  tenantId: string;
  sessionId: string;
  refreshServices(): Promise<void>;
}): AgentTool {
  return {
    name: "preview",
    label: "Open Application",
    description:
      "Publish a verified HTTP service already listening inside the current Sandbox as an authenticated PiCloud application link. Call this after starting and validating a Web server. This Tool does not start or restart the server.",
    parameters: PreviewToolSchema,
    async execute(_toolCallId, raw) {
      const input = raw as { port: number; path?: string };
      await options.refreshServices();
      const session = await options.database
        .selectFrom("sessions")
        .select("development_environment_id")
        .where("tenant_id", "=", options.tenantId)
        .where("id", "=", options.sessionId)
        .executeTakeFirstOrThrow();
      const targetKind =
        session.development_environment_id === null ? "conversation" : "development_environment";
      const targetId = session.development_environment_id ?? options.sessionId;
      const service = await options.database
        .selectFrom("sandbox_http_services")
        .select("id")
        .where("tenant_id", "=", options.tenantId)
        .where("target_kind", "=", targetKind)
        .where("target_id", "=", targetId)
        .where("port", "=", input.port)
        .where("protocol", "=", "http")
        .where("state", "=", "active")
        .orderBy("last_seen_at", "desc")
        .executeTakeFirst();
      if (service === undefined) {
        throw new Error(
          `preview_service_not_found: no verified HTTP service is listening on port ${String(input.port)}`,
        );
      }
      const suffix = input.path ?? "/";
      const previewPath = `/v1/conversations/${encodeURIComponent(options.sessionId)}/preview/${String(input.port)}${suffix}`;
      return {
        content: [
          {
            type: "text",
            text: `PiCloud published the verified service on port ${String(input.port)} as an authenticated Open application link. Refer to the rendered link instead of printing localhost or inventing a public URL.`,
          },
        ],
        details: {
          serviceId: service.id,
          port: input.port,
          protocol: "http",
          previewPath,
        },
      };
    },
  };
}
