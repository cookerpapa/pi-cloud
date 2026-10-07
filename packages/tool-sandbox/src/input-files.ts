import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  writeWorkspaceUpload,
  UploadStagingArea,
  UPLOAD_STAGING_NAME,
  registerUploadStaging,
  reapRegisteredUploads,
} from "@pi-cloud/workspace-runtime";
import { processImageSource } from "./image-processor.ts";

export async function prepareInputFile(
  value: unknown,
  options: { registryDirectory?: string } = {},
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid input file request");
  const input = value as Record<string, unknown>;
  const registry = options.registryDirectory ?? "/home/user/.pi-cloud-upload-areas-v1";
  if (input.mode === "reap_upload_staging" && Object.keys(input).length === 1)
    return reapRegisteredUploads(registry);
  if (
    typeof input.sourcePath !== "string" ||
    !/^\/tmp\/pi-cloud-upload-[0-9a-f-]{36}$/.test(input.sourcePath) ||
    !Number.isSafeInteger(input.byteLength) ||
    (input.byteLength as number) < 1
  )
    throw new Error("Invalid input file identity");
  const source = await open(input.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.size !== input.byteLength)
      throw new Error("Input file length changed");
    if (input.mode === "normalize_image") {
      if (typeof input.mimeType !== "string") throw new Error("Missing image format");
      const result = await processImageSource(`/proc/self/fd/${source.fd}`, {
        autoResizeImages: true,
      });
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
    const { id, name, sha256 } = input;
    const root = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const staging = new UploadStagingArea(join(directory, UPLOAD_STAGING_NAME));
    try {
      await staging.prepare();
      const identity = await registerUploadStaging(registry, staging.directory);
      const owned = new UploadStagingArea(staging.directory, identity);
      await owned.reap();
      return await owned.use((files) =>
        writeWorkspaceUpload(
          root,
          {
            id,
            name,
            sha256,
            chunks: source.createReadStream({ autoClose: false }),
            byteLength: input.byteLength as number,
          },
          files,
        ),
      );
    } finally {
      await root.close();
      await staging.reap().catch(() => undefined);
    }
  } finally {
    await source.close();
  }
}
