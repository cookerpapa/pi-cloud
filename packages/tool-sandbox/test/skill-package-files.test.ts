import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareSkillPackage } from "../src/skill-package-files.ts";
it("atomically places package files without running scripts, verifies reuse and preserves modified copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-skill-"));
  const bytes = Buffer.from(
    JSON.stringify({
      name: "test-skill",
      requirements: { tools: [], runtime: "none", software: [] },
      files: [
        { path: "SKILL.md", base64: Buffer.from("Instructions").toString("base64") },
        {
          path: "scripts/run.sh",
          base64: Buffer.from("touch should-not-exist").toString("base64"),
        },
      ],
    }),
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  try {
    const [a, b] = await Promise.all([
      prepareSkillPackage(root, bytes, digest),
      prepareSkillPackage(root, bytes, digest),
    ]);
    expect(a).toEqual(b);
    expect(await readFile(join(a.path, "SKILL.md"), "utf8")).toBe("Instructions");
    expect(await readdir(root)).toEqual([".pi-cloud"]);
    await writeFile(join(a.path, "SKILL.md"), "User edits");
    await expect(prepareSkillPackage(root, bytes, digest)).rejects.toThrow("modified");
    expect(await readFile(join(a.path, "SKILL.md"), "utf8")).toBe("User edits");
    expect(await readdir(join(root, ".pi-cloud", "skills"))).toEqual([`test-skill-${digest}`]);
    await expect(prepareSkillPackage(root, bytes, "a".repeat(64))).rejects.toThrow("digest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
