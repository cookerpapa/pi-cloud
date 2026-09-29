import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { MAX_USER_UPLOAD_BYTES } from "@pi-cloud/protocol/guest";
import { writeWorkspaceUpload } from "@pi-cloud/workspace-runtime";
import { processReadImage } from "./image-processor.ts";

export async function prepareInputFile(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid input file request");
  const input = value as Record<string, unknown>;
  if (
    typeof input.data !== "string" ||
    input.data.length > Math.ceil(MAX_USER_UPLOAD_BYTES / 3) * 4
  )
    throw new Error("Input file exceeds its limit");
  const bytes = Buffer.from(input.data, "base64");
  if (
    !bytes.length ||
    bytes.toString("base64") !== input.data ||
    bytes.length > MAX_USER_UPLOAD_BYTES
  )
    throw new Error("Invalid input file data");
  if (input.mode === "normalize_image") {
    if (typeof input.mimeType !== "string") throw new Error("Missing image format");
    const result = await processReadImage(bytes, input.mimeType, { autoResizeImages: true });
    if (!result.ok) throw new Error(result.message);
    return { data: result.data, mimeType: result.mimeType, hints: result.hints };
  }
  if (
    input.mode !== "upload_file" ||
    typeof input.directory !== "string" ||
    !input.directory.startsWith("/") ||
    typeof input.id !== "string" ||
    typeof input.name !== "string" ||
    typeof input.sha256 !== "string"
  )
    throw new Error("Invalid Workspace upload request");
  const directory = await realpath(input.directory);
  const root = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    return await writeWorkspaceUpload(root, {
      id: input.id,
      name: input.name,
      sha256: input.sha256,
      bytes,
    });
  } finally {
    await root.close();
  }
}
