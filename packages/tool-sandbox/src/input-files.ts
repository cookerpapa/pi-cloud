import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  writeWorkspaceUpload,
  writeGeneratedImage,
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
  if (input.mode === "read_reference_image") {
    if (
      typeof input.path !== "string" ||
      typeof input.directory !== "string" ||
      !input.directory.startsWith("/")
    )
      throw new Error("Invalid reference image path");
    const file = await open(
      resolve(input.directory, input.path),
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024 * 1024)
        throw new Error("Reference image is not a bounded regular file");
      const result = await processImageSource(`/proc/self/fd/${file.fd}`, {
        autoResizeImages: false,
      });
      if (!result.ok) throw new Error(result.message);
      return { data: result.data, mimeType: result.mimeType, hints: result.hints };
    } finally {
      await file.close();
    }
  }
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
    if (input.mode === "save_generated_image") {
      if (
        typeof input.directory !== "string" ||
        !input.directory.startsWith("/") ||
        typeof input.id !== "string"
      )
        throw new Error("Invalid generated image destination");
      const result = await processImageSource(`/proc/self/fd/${source.fd}`, {
        autoResizeImages: false,
      });
      if (!result.ok) throw new Error(result.message);
      const bytes = Buffer.from(result.data, "base64");
      let root;
      let staging;
      try {
        const directory = await realpath(input.directory);
        root = await open(
          directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        staging = new UploadStagingArea(join(directory, UPLOAD_STAGING_NAME));
        await staging.prepare();
        const identity = await registerUploadStaging(registry, staging.directory);
        const owned = new UploadStagingArea(staging.directory, identity);
        await owned.reap();
        const receipt = await owned.use((files) =>
          writeGeneratedImage(
            root!,
            {
              id: input.id as string,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              byteLength: bytes.length,
              chunks: (async function* () {
                yield bytes;
              })(),
            },
            files,
          ),
        );
        return {
          data: result.data,
          mimeType: result.mimeType,
          hints: result.hints,
          path: join(directory, receipt.relativePath),
        };
      } catch {
        return {
          data: result.data,
          mimeType: result.mimeType,
          hints: result.hints,
          placementError:
            "The image was generated, but Workspace placement failed. Do not regenerate it merely to retry file placement.",
        };
      } finally {
        await root?.close();
        await staging?.reap().catch(() => undefined);
      }
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
