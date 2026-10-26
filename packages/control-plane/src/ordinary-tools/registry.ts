import { createScheduleTool } from "./schedule-tool.ts";
import { SessionScheduleService } from "../session-schedule-service.ts";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import type { ConfiguredImageAttachments } from "@pi-cloud/session-attachments";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
import { ControlToolRegistry, type RegisteredControlTool } from "../control-tool-registry.ts";
import { createImageTool, createShowImageTool } from "./image-tool.ts";
import { executePreviewTool, previewToolDefinition } from "./preview-tool.ts";
import type { ImageGenerationClient } from "./image-generation-client.ts";

/** Execution-owned definitions and handlers; adding an ordinary Tool needs no Worker edit. */
export function createOrdinaryToolRegistry(options: {
  database: Kysely<Database>;
  schedules?: SessionScheduleService;
  enabled?: readonly string[];
  images?: ConfiguredImageAttachments;
  imageGeneration?: ImageGenerationClient;
  imageIo: Parameters<typeof createShowImageTool>[0]["imageIo"];
  refreshServices(command: AcceptedControlToolCommand): Promise<void>;
}): ControlToolRegistry {
  const definitions: RegisteredControlTool[] = [
    createScheduleTool(
      options.schedules ?? new SessionScheduleService({ database: options.database }),
    ),
    {
      definition: previewToolDefinition,
      execute: (call, current) =>
        executePreviewTool(options.database, call, async () => {
          if (!call.bindingId) throw new Error("Preview requires an admitted Tool binding");
          if (!current()) throw new Error("Control Tool owner changed");
          await options.refreshServices(call);
        }),
    },
  ];
  if (options.images) {
    const common = { images: options.images, imageIo: options.imageIo };
    definitions.push(createShowImageTool(common));
    if (options.imageGeneration)
      definitions.push(
        createImageTool({ ...common, database: options.database, client: options.imageGeneration }),
      );
  }
  if (options.enabled?.some((name) => !definitions.some((tool) => tool.definition.name === name)))
    throw new TypeError("Configured ordinary Control Tool is not registered");
  const registry = new ControlToolRegistry();
  for (const tool of definitions)
    if (!options.enabled || options.enabled.includes(tool.definition.name)) registry.register(tool);
  return registry;
}
