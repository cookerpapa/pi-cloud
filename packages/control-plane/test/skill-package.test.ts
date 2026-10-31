import { expect, it } from "vitest";
import { skillPackage, importGitHubSkill } from "../src/skill-package.ts";
import { skillAvailability } from "@pi-cloud/protocol";
const file = (path: string, text: string) => ({
  path,
  base64: Buffer.from(text).toString("base64"),
});
const main = file(
  "SKILL.md",
  "---\nname: test-skill\ndescription: Test skill\ncompatibility: Needs Python\n---\nFollow these steps.",
);
it("keeps portable Skill files and compatibility prose without executing or inferring it", () => {
  const parsed = skillPackage([
    file("scripts/run.py", "raise Exception('must not execute')"),
    main,
  ]);
  expect(parsed.compatibility).toBe("Needs Python");
  expect(parsed.content.files).toHaveLength(2);
  expect(skillPackage([...parsed.content.files].reverse()).digest).toBe(parsed.digest);
  expect(
    skillAvailability({ tools: ["camera"], runtime: "android", software: [] }, "linux", ["bash"]),
  ).toEqual({ state: "unsupported", reasons: ["tool:camera", "runtime:android"] });
  expect(
    skillAvailability({ tools: [], runtime: "none", software: ["python"] }, "linux", ["bash"])
      .state,
  ).toBe("unverified");
});
it("rejects invalid package trees before creating a published version", () => {
  for (const files of [
    [main, main],
    [main, file("../bad", "x")],
    [main, file("a", "x"), file("a/b", "x")],
    [file("SKILL.md", "without frontmatter")],
  ])
    expect(() => skillPackage(files)).toThrow();
});
it("resolves a Git source to immutable tree/blob identities and rejects symlink packages", async () => {
  const requests: string[] = [],
    commit = "a".repeat(40);
  let mode = "100644";
  const source = {
    kind: "github" as const,
    repository: "example/workflows",
    ref: "main",
    path: "skills/test-skill",
  };
  const fetcher = (async (url: string) => {
    requests.push(url);
    const value = url.includes("/commits/")
      ? { sha: commit, commit: { tree: { sha: "root" } } }
      : url.endsWith("/trees/root")
        ? { tree: [{ type: "tree", path: "skills", sha: "skills" }] }
        : url.endsWith("/trees/skills")
          ? { tree: [{ type: "tree", path: "test-skill", sha: "package" }] }
          : url.includes("/trees/package")
            ? { tree: [{ type: "blob", mode, size: 100, path: "SKILL.md", sha: "blob" }] }
            : { encoding: "base64", content: main.base64 };
    return Response.json(value);
  }) as typeof fetch;
  const result = await importGitHubSkill(source, fetcher, new AbortController().signal);
  expect(result.source).toEqual({ ...source, commit });
  expect(result.files).toEqual([main]);
  expect(requests.filter((url) => url.includes("main"))).toHaveLength(1);
  mode = "120000";
  await expect(importGitHubSkill(source, fetcher, new AbortController().signal)).rejects.toThrow(
    "regular files",
  );
});
