import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, symlink, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSkillPackage } from "../src/skill-package-export.ts";
it("exports complete binary/Unicode files without running scripts or applying Tool-output truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-export-"));
  try {
    await writeFile(join(root, "SKILL.md"), "---\nname: test\ndescription: 测试\n---\n# 说明");
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts/run.sh"), "touch never-run");
    const bytes = Buffer.alloc(5 * 1024 * 1024, 211);
    await writeFile(join(root, "asset.bin"), bytes);
    const value = await exportSkillPackage(root, ".");
    expect(value.files.map((f) => f.path)).toEqual(
      ["asset.bin", "scripts/run.sh", "SKILL.md"].sort((a, b) => a.localeCompare(b, "en")),
    );
    const actual = Buffer.from(value.files.find((f) => f.path === "asset.bin")!.base64, "base64");
    expect(actual.length).toBe(bytes.length);
    expect(createHash("sha256").update(actual).digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(
      Buffer.from(value.files.find((f) => f.path === "SKILL.md")!.base64, "base64").toString(),
    ).toContain("测试");
    await expect(open(join(root, "never-run"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects missing manifests, symbolic resources and oversized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-export-"));
  try {
    await expect(exportSkillPackage(root, ".")).rejects.toThrow("SKILL.md");
    await writeFile(join(root, "SKILL.md"), "instructions");
    await symlink("SKILL.md", join(root, "linked.md"));
    await expect(exportSkillPackage(root, ".")).rejects.toThrow("regular files");
    await rm(join(root, "linked.md"));
    const file = await open(join(root, "large"), "w");
    await file.truncate(16 * 1024 * 1024 + 1);
    await file.close();
    await expect(exportSkillPackage(root, ".")).rejects.toThrow("16 MiB");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
