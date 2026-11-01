import { expect, it } from "vitest";
import { skillPackage } from "../src/skill-package.ts";
const file = (path: string, text: string) => ({
  path,
  base64: Buffer.from(text).toString("base64"),
});
const manifest = (extra = "") =>
  file(
    "SKILL.md",
    `---\nname: example\ndescription: A reusable workflow\n${extra}---\nInstructions`,
  );
it("keeps instructions, license text and textual references independent of a Workspace", () => {
  expect(
    skillPackage([
      manifest(),
      file("LICENSE", "License"),
      file("README.md", "Docs"),
      file("references/guide.json", "{}"),
    ]).runtimeMetadata,
  ).toEqual({ disableModelInvocation: false, requiresWorkspaceFiles: false });
});
it("records explicit invocation and execution resources without running them", () => {
  expect(
    skillPackage([
      manifest("disable-model-invocation: true\n"),
      file("scripts/check.py", "print('ok')"),
    ]).runtimeMetadata,
  ).toEqual({ disableModelInvocation: true, requiresWorkspaceFiles: true });
  expect(
    skillPackage([manifest(), file("assets/template.md", "Template")]).runtimeMetadata
      .requiresWorkspaceFiles,
  ).toBe(true);
  expect(
    skillPackage([
      manifest(),
      { path: "references/binary.md", base64: Buffer.from([255, 0]).toString("base64") },
    ]).runtimeMetadata.requiresWorkspaceFiles,
  ).toBe(true);
});
