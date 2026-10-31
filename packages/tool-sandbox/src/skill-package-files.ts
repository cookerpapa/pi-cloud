import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseSkill,
  SkillPackageContentSchema,
  SKILL_PACKAGE_BYTES,
  SKILL_ENVELOPE_BYTES,
  validSkillPath,
  type SkillPackageContent,
} from "@pi-cloud/protocol";

/** Data-only package placement. This function runs as the untrusted guest user. */
export async function prepareSkillPackage(directory: string, bytes: Buffer, digest: string) {
  if (
    bytes.length > SKILL_ENVELOPE_BYTES ||
    createHash("sha256").update(bytes).digest("hex") !== digest
  )
    throw new Error("Skill package digest changed");
  const content = parseSkill<SkillPackageContent>(
    SkillPackageContentSchema,
    JSON.parse(bytes.toString("utf8")),
  );
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const file of content.files) {
    if (!validSkillPath(file.path) || files.has(file.path))
      throw new Error("Invalid Skill package path");
    const data = Buffer.from(file.base64, "base64");
    total += data.length;
    if (total > SKILL_PACKAGE_BYTES || data.toString("base64") !== file.base64)
      throw new Error("Invalid Skill file data");
    files.set(file.path, data);
  }
  if (!files.has("SKILL.md")) throw new Error("Skill instructions are missing");
  const root = await realpath(directory);
  const ensureDirectory = async (path: string) => {
    await mkdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await lstat(path)).isDirectory()) throw new Error("Skill destination is not a directory");
  };
  const parent = join(root, ".pi-cloud");
  await ensureDirectory(parent);
  const packages = join(parent, "skills");
  await ensureDirectory(packages);
  const target = join(packages, `${content.name}-${digest}`);
  const verify = async () => {
    if (!(await lstat(target)).isDirectory()) throw new Error("Skill destination changed");
    for (const [path, expected] of files) {
      let current = target;
      for (const part of path.split("/").slice(0, -1)) {
        current = join(current, part);
        if (!(await lstat(current)).isDirectory()) throw new Error("Skill directory changed");
      }
      const file = await open(
        join(target, path),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size !== expected.length ||
          !(await file.readFile()).equals(expected)
        )
          throw new Error("Existing Skill copy was modified");
      } finally {
        await file.close();
      }
    }
  };
  if (
    await lstat(target).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  ) {
    await verify();
    return { path: target };
  }
  const temporary = await mkdtemp(join(packages, ".prepare-"));
  try {
    for (const [path, data] of files) {
      await mkdir(dirname(join(temporary, path)), { recursive: true });
      const file = await open(join(temporary, path), "wx", 0o644);
      try {
        await file.writeFile(data);
      } finally {
        await file.close();
      }
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      await verify();
    }
    return { path: target };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
