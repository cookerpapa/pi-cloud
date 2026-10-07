import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import { prepareInputFile } from "../src/input-files.ts";
import {
  UploadStagingArea,
  registerUploadStaging,
  UPLOAD_STAGING_NAME,
} from "@pi-cloud/workspace-runtime";

const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { force: true });
});
async function source(bytes: Buffer) {
  const sourcePath = `/tmp/pi-cloud-upload-${randomUUID()}`;
  paths.push(sourcePath);
  await writeFile(sourcePath, bytes);
  return { sourcePath, byteLength: bytes.length };
}

it("normalizes uploaded images inside the fixed guest with the existing image policy", async () => {
  const input = await sharp({
    create: { width: 4000, height: 2000, channels: 3, background: "#5988f7" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const result = await prepareInputFile({
    mode: "normalize_image",
    ...(await source(input)),
    mimeType: "image/jpeg",
  });
  expect(result).toHaveProperty("mimeType", "image/png");
  if (!("data" in result)) throw new Error("No image");
  const metadata = await sharp(Buffer.from(result.data, "base64")).metadata();
  expect(metadata.height).toBeLessThan(4000);
  expect(metadata.height).toBe(metadata.width! * 2);
  expect(metadata.exif).toBeUndefined();
  await expect(
    prepareInputFile({
      mode: "normalize_image",
      ...(await source(Buffer.from("broken"))),
      mimeType: "image/png",
    }),
  ).rejects.toThrow();
  await expect(
    prepareInputFile({ mode: "normalize_image", data: "not base64", mimeType: "image/png" }),
  ).rejects.toThrow();
});

it("places machine uploads under the selected working directory without overwriting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "input-files-"));
  const bytes = Buffer.from("uploaded file"),
    id = randomUUID();
  const input = {
    mode: "upload_file",
    id,
    name: "note.txt",
    directory,
    ...(await source(bytes)),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  try {
    const options = { registryDirectory: join(directory, "registry") };
    const result = await prepareInputFile(input, options);
    expect(result).toHaveProperty("relativePath", `uploads/${id}/note.txt`);
    expect(await readFile(join(directory, "uploads", id, "note.txt"))).toEqual(bytes);
    expect(await prepareInputFile(input, options)).toEqual(result);
    await expect(prepareInputFile({ ...input, name: "../escape" }, options)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reclaims registered guest staging after the upload request is gone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guest-upload-recovery-")),
    registryDirectory = join(directory, "registry");
  try {
    const area = new UploadStagingArea(join(directory, UPLOAD_STAGING_NAME));
    await area.prepare();
    await registerUploadStaging(registryDirectory, area.directory);
    await area.use((files) =>
      writeFile(`/proc/self/fd/${files.fd}/.part-${randomUUID()}`, "abandoned"),
    );
    expect(
      await prepareInputFile({ mode: "reap_upload_staging" }, { registryDirectory }),
    ).toMatchObject({ files: 1, bytes: 9, deferred: 0 });
    expect(
      await prepareInputFile({ mode: "reap_upload_staging" }, { registryDirectory }),
    ).toMatchObject({ files: 0, deferred: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
