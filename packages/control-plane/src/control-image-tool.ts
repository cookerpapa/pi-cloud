import { readDurableEntries } from "@pi-cloud/pi-session-postgres/durable";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import {
  parseImageAttachmentReference,
  type ImageAttachmentReference,
  type SandboxControlRequest,
  type SandboxControlResponse,
} from "@pi-cloud/protocol";
import type { ImageAttachmentCodec, ImageAttachmentStore } from "@pi-cloud/session-attachments";
import type { RegisteredControlTool } from "./control-tool-registry.ts";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
import {
  ImageGenerationError,
  type GenerationImage,
  type ImageGenerationClient,
} from "./image-generation-client.ts";

type Args = {
  prompt: string;
  referenced_image_paths?: string[] | null;
  num_last_images_to_include?: number | null;
  transparent_background?: boolean;
};
type ImageIoRequest = Extract<SandboxControlRequest, { type: "tool_sandbox.image_io" }>;
type ImageIoResult = Extract<SandboxControlResponse, { type: "tool_sandbox.image_io_result" }>;

/** The model sees only the same four arguments as Codex's image-generation Tool. */
export const imageToolDefinition = {
  name: "generate_image",
  description:
    "Generate or edit one image using the configured image service. Provide prompt and optionally reference images: use referenced_image_paths for files accessible in the current Sandbox, or num_last_images_to_include for the last 1–5 images visible in this Conversation. Never use both. Omit both for a new image from text. Inspect local references with read before editing. Set transparent_background for transparent assets. The Tool saves a new file under generated_images in the current working directory and returns the image and actual path. Do not call again merely because a previous result is UNKNOWN. Use the returned preview path to show the image, and copy the saved file into the project when needed.",
  requiresEnvironment: true,
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", minLength: 1 },
      referenced_image_paths: {
        anyOf: [
          { type: "array", items: { type: "string", minLength: 1, maxLength: 4096 }, maxItems: 5 },
          { type: "null" },
        ],
      },
      num_last_images_to_include: {
        anyOf: [{ type: "integer", minimum: 1, maximum: 5 }, { type: "null" }],
      },
      transparent_background: { type: "boolean" },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

/** Indexed active context only; the issuing assistant entry fixes the cutoff. */
export async function recentConversationImages(
  database: Kysely<Database>,
  command: AcceptedControlToolCommand,
  count: number,
  signal: AbortSignal,
): Promise<ImageAttachmentReference[]> {
  if (!command.invocationEntryId) throw new Error("The Tool's original context is unavailable");
  let through = command.invocationEntryId;
  let from: number | undefined;
  const selected: ImageAttachmentReference[] = [];
  const seen = new Set<string>();
  for (;;) {
    signal.throwIfAborted();
    const page = await readDurableEntries(database, {
      tenantId: command.scope.tenantId,
      sessionId: command.scope.piSessionId,
      conversationId: command.conversationId,
      through,
      ...(from === undefined ? {} : { from }),
      activeOnly: true,
      limit: 64,
    });
    for (const { entry } of page) {
      if (entry.head !== undefined) from = Math.max(from ?? 0, entry.head);
      for (const message of [...(entry.model ?? [])].reverse()) {
        if (message.role !== "user" && message.role !== "toolResult") continue;
        if (!Array.isArray(message.content)) continue;
        for (const part of [...message.content].reverse()) {
          if (typeof part === "string") continue;
          if (part.type !== "pi_cloud_image_v1") continue;
          const ref = parseImageAttachmentReference(part.attachment);
          if (seen.has(ref.id)) continue;
          seen.add(ref.id);
          selected.push(ref);
          if (selected.length === count) return selected.reverse();
        }
      }
    }
    if (page.length < 64) break;
    through = page.at(-1)!.entry.id - 1;
    if (from !== undefined && through < from) break;
  }
  throw new Error(
    `Requested ${count} recent Conversation images, but only ${selected.length} are available in the active context. Provide reference file paths or attach the missing images.`,
  );
}

export function createImageTool(options: {
  database: Kysely<Database>;
  images: { codec: ImageAttachmentCodec; store: ImageAttachmentStore };
  client: Pick<ImageGenerationClient, "generate">;
  imageIo(
    command: AcceptedControlToolCommand,
    action: ImageIoRequest["action"],
    signal: AbortSignal,
  ): Promise<ImageIoResult>;
  recentImages?: typeof recentConversationImages;
}): RegisteredControlTool {
  let active = 0;
  return {
    definition: imageToolDefinition,
    replay: "never",
    async execute(command, current, outerSignal) {
      const signal = outerSignal ?? new AbortController().signal;
      const failure = (text: string) => ({
        isError: true,
        result: { content: [{ type: "text" as const, text }] },
      });
      const args = command.arguments as Args;
      if ((args.referenced_image_paths?.length ?? 0) > 0 && args.num_last_images_to_include != null)
        return failure(
          "invalid_arguments: Choose referenced_image_paths or num_last_images_to_include, never both.",
        );
      if (!args.prompt.trim())
        return failure("invalid_arguments: The image prompt must not be empty.");
      if (!command.bindingId)
        return failure("tool_unavailable: Image generation requires a current Workspace binding.");
      // Bound concurrent large provider replies, not product usage or Run duration.
      if (active >= 8)
        return failure(
          "image_service_busy: The local image transfer slots are occupied. No image request was sent.",
        );
      active++;
      let requested = false;
      try {
        signal.throwIfAborted();
        const refs: ImageAttachmentReference[] = [];
        if (args.num_last_images_to_include != null)
          refs.push(
            ...(await (options.recentImages ?? recentConversationImages)(
              options.database,
              command,
              args.num_last_images_to_include,
              signal,
            )),
          );
        else
          for (const path of args.referenced_image_paths ?? []) {
            if (!current()) throw new Error("Tool ownership changed");
            refs.push((await options.imageIo(command, { kind: "read", path }, signal)).image);
          }
        const images: GenerationImage[] = [];
        let referenceBytes = 0;
        for (const reference of refs) {
          referenceBytes += reference.byteLength;
          if (referenceBytes > 64 * 1024 * 1024)
            return failure(
              "image_references_too_large: The combined reference images exceed the image transport budget. No image request was sent.",
            );
          images.push({
            mimeType: reference.mimeType,
            data: (
              await options.images.store.get(command.scope.tenantId, reference, signal)
            ).toString("base64"),
          });
        }
        signal.throwIfAborted();
        if (!current()) throw new Error("Tool ownership changed before provider admission");
        let generated: GenerationImage;
        try {
          requested = true;
          generated = await options.client.generate(
            { prompt: args.prompt, images, transparent: args.transparent_background ?? false },
            signal,
          );
        } catch (error) {
          signal.throwIfAborted();
          return failure(
            `${error instanceof ImageGenerationError && !error.uncertain ? "image_generation_failed" : "tool_result_unknown"}: ${error instanceof ImageGenerationError ? error.message : "The image request did not return a confirmed result. It was not retried."}`,
          );
        }
        signal.throwIfAborted();
        if (!current()) throw new Error("Tool ownership changed after provider response");
        const scope = { tenantId: command.scope.tenantId, runId: command.scope.runId };
        // Persist received pixels before attempting mutable Workspace placement.
        const source = await options.images.codec.pack(
          scope,
          { type: "image" as const, ...generated },
          signal,
        );
        // Guest decoding must succeed before pixels enter model context.
        // Placement alone may fail while still returning a validated image.
        const result = await options.imageIo(
          command,
          { kind: "save", source: source.attachment },
          signal,
        );
        const image = result.image;
        const content = await options.images.codec.unpack<{
          type: "image";
          data: string;
          mimeType: string;
        }>(scope, { type: "pi_cloud_image_v1", attachment: image }, signal);
        const previewPath = `/v1/sessions/${command.scope.sessionId}/images/${image.id}`;
        const text = result?.path
          ? `Image generated and saved to ${result.path}.\nImage preview: ${previewPath}\nUse this preview path when showing the image; use the saved file in your project.`
          : `Image generated and retained in this conversation, but its Workspace file was not saved.\nImage preview: ${previewPath}\nDo not regenerate merely to retry saving the image.`;
        return {
          result: {
            content: [{ type: "text" as const, text }, content],
            details: {
              generatedImage: {
                previewPath,
                imageId: image.id,
                ...(result?.path ? { path: result.path } : {}),
                fileSaved: Boolean(result?.path),
                referenceCount: refs.length,
              },
            },
          },
        };
      } catch (error) {
        signal.throwIfAborted();
        return failure(
          requested
            ? "tool_result_unknown: Generation was requested, but its image could not be retained or delivered. No automatic regeneration was sent."
            : `image_reference_unavailable: ${error instanceof Error && error.message.startsWith("Requested ") ? error.message : "The reference images or current Workspace could not be read. No image request was sent."}`,
        );
      } finally {
        active--;
      }
    },
  };
}
