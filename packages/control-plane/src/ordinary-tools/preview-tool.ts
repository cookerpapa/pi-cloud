import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
import type { ControlToolOutcome } from "../control-tool-dispatcher.ts";
import type { ControlToolCatalogDefinition } from "@pi-cloud/protocol";

export const previewToolDefinition: ControlToolCatalogDefinition = {
  name: "preview",
  description:
    "Publish a verified HTTP service already listening inside the current Sandbox as an authenticated PiCloud application link. Include the returned application path as a Markdown link in your final answer. This Tool does not start or restart the server.",
  parameters: {
    type: "object",
    properties: {
      port: { type: "integer", minimum: 1024, maximum: 65535 },
      path: {
        type: "string",
        minLength: 1,
        maxLength: 2048,
        pattern: "^/[^\\u0000-\\u001f\\u007f ]*$",
      },
    },
    required: ["port"],
    additionalProperties: false,
  },
  requiresEnvironment: true,
};

/** Platform business logic; process/filesystem inspection stays in Cube. */
export async function executePreviewTool(
  database: Kysely<Database>,
  command: AcceptedControlToolCommand,
  refresh: () => Promise<void>,
): Promise<Extract<ControlToolOutcome, { result: unknown }>> {
  const input = command.arguments as { port: number; path?: string };
  await refresh();
  const session = await database
    .selectFrom("sessions")
    .select(["development_environment_id", "compute_session_id"])
    .where("tenant_id", "=", command.scope.tenantId)
    .where("id", "=", command.scope.sessionId)
    .executeTakeFirstOrThrow();
  const machine =
    session.development_environment_id !== null && session.compute_session_id === null;
  const service = await database
    .selectFrom("sandbox_http_services")
    .select("id")
    .where("tenant_id", "=", command.scope.tenantId)
    .where("target_kind", "=", machine ? "development_environment" : "conversation")
    .where(
      "target_id",
      "=",
      machine ? session.development_environment_id! : command.scope.sessionId,
    )
    .where("port", "=", input.port)
    .where("protocol", "=", "http")
    .where("state", "=", "active")
    .orderBy("last_seen_at", "desc")
    .executeTakeFirst();
  if (!service)
    return {
      isError: true,
      result: {
        content: [
          {
            type: "text",
            text:
              "preview_service_not_found: no verified HTTP service is listening on port " +
              input.port,
          },
        ],
      },
    };
  const previewPath =
    "/v1/conversations/" +
    encodeURIComponent(command.scope.sessionId) +
    "/preview/" +
    input.port +
    (input.path ?? "/");
  return {
    result: {
      content: [
        {
          type: "text",
          text:
            "PiCloud published the verified service on port " +
            input.port +
            ".\nOpen application: " +
            previewPath +
            "\nUse this authenticated platform path as a Markdown link in your answer.",
        },
      ],
      details: {
        serviceId: service.id,
        port: input.port,
        protocol: "http",
        previewPath,
      },
    },
  };
}
