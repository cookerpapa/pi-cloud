import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, utimes, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reapUploadTransit } from "../src/upload-transit-cleanup.ts";
it("expires only stale fixed upload transit sources, never live chunks or Tool envelopes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-transit-test-"));
  const stale = `pi-cloud-upload-${randomUUID()}`,
    current = `pi-cloud-upload-${randomUUID()}`;
  const envelope = `pi-cloud-envd-${randomUUID()}.json`,
    link = `pi-cloud-upload-${randomUUID()}`;
  try {
    for (const name of [stale, current, envelope, "user-file"])
      await writeFile(join(directory, name), "data");
    for (const name of [stale, envelope, "user-file"])
      await utimes(join(directory, name), new Date(0), new Date(0));
    await symlink(join(directory, "user-file"), join(directory, link));
    expect(await reapUploadTransit(directory)).toEqual({ files: 1, bytes: 4 });
    expect((await readdir(directory)).sort()).toEqual(
      [current, envelope, "user-file", link].sort(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
