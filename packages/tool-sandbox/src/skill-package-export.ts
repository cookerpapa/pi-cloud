import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { SKILL_PACKAGE_BYTES, validSkillPath, type SkillFile } from "@pi-cloud/protocol/skills";
export class SkillPackageExportError extends Error {
  readonly code = "skill_export_invalid";
}
const invalid = (message: string): never => {
  throw new SkillPackageExportError(message);
};
const stamp = (stat: BigIntStats) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
/** Fixed guest data operation. Reads regular package files; never runs package code. */
export async function exportSkillPackage(
  cwd: string,
  path: string,
): Promise<{ files: SkillFile[] }> {
  try {
    if (!cwd.startsWith("/") || !path || path.includes("\0"))
      return invalid("A Skill directory is required.");
    const root = await realpath(resolve(cwd, path));
    const main = await lstat(join(root, "SKILL.md"));
    if (!main.isFile() || main.isSymbolicLink())
      return invalid("The directory needs a regular SKILL.md file.");
    const files: SkillFile[] = [],
      observed: Array<{ path: string; stamp: string }> = [];
    let total = 0,
      entries = 0;
    async function visit(directory: string, prefix: string): Promise<void> {
      const before = await lstat(directory, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink())
        invalid("Skill directories must not be symbolic links.");
      observed.push({ path: directory, stamp: stamp(before) });
      for await (const entry of await opendir(directory)) {
        if (++entries > 4096) invalid("Skill directory exceeds its traversal envelope.");
        const relative = prefix + entry.name;
        if (!validSkillPath(relative)) invalid("A Skill file path is invalid or too long.");
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(full, relative + "/");
          continue;
        }
        if (!entry.isFile())
          invalid("Skill packages support regular files, not links or special files.");
        if (files.length >= 512) invalid("Skill package exceeds 512 files.");
        const handle = await open(
          full,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const initial = await handle.stat({ bigint: true });
          if (!initial.isFile() || initial.size > BigInt(SKILL_PACKAGE_BYTES - total))
            invalid("Skill package exceeds 16 MiB.");
          const length = Number(initial.size),
            bytes = Buffer.alloc(length);
          let position = 0;
          while (position < length) {
            const part = await handle.read(
              bytes,
              position,
              Math.min(65536, length - position),
              position,
            );
            if (!part.bytesRead)
              invalid("Skill files changed during export. Finish editing and retry.");
            position += part.bytesRead;
          }
          if (stamp(initial) !== stamp(await handle.stat({ bigint: true })))
            invalid("Skill files changed during export. Finish editing and retry.");
          observed.push({ path: full, stamp: stamp(initial) });
          total += length;
          files.push({ path: relative, base64: bytes.toString("base64") });
        } finally {
          await handle.close();
        }
      }
    }
    await visit(root, "");
    for (const item of observed)
      if (item.stamp !== stamp(await lstat(item.path, { bigint: true })))
        invalid("Skill files changed during export. Finish editing and retry.");
    return { files: files.sort((a, b) => a.path.localeCompare(b.path, "en")) };
  } catch (cause) {
    if (cause instanceof SkillPackageExportError) throw cause;
    return invalid(
      "Skill files could not be read. Check the directory, SKILL.md and file permissions.",
    );
  }
}
