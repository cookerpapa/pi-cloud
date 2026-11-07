import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Share the source receipt adapter without duplicating it in a native patch.
 * Every copied byte is part of the fixed Cube build manifest. */
export async function materializeCubeOwnedSources(root, target, manifest) {
  for (const source of manifest.ownedSources ?? []) {
    if (
      !/^deploy\/[a-z-]+$/.test(source.directory) ||
      !/^PiCloud\/[a-z-]+$/.test(source.target) ||
      !Array.isArray(source.files) ||
      !source.files.length ||
      source.files.some((name) => !/^[a-zA-Z0-9_.-]+$/.test(name))
    )
      throw new Error("Invalid Cube owned-source manifest");
    const digest = createHash("sha256"),
      files = [];
    for (const name of [...source.files].sort()) {
      const body = await readFile(join(root, source.directory, name));
      digest.update(name).update("\0").update(body).update("\0");
      files.push([name, body]);
    }
    if (digest.digest("hex") !== source.sha256)
      throw new Error(`Cube owned source changed: ${source.directory}`);
    await mkdir(join(target, source.target), { recursive: true });
    for (const [name, body] of files) await writeFile(join(target, source.target, name), body);
  }
}
