import { expect, it } from "vitest";
import {
  matchesSkill,
  sameSkillScope,
  skillBase64,
  skillText,
  skillBody,
  type SkillPackage,
} from "../src/skill-package-view.tsx";
const version = {
  versionId: "v2",
  packageId: "p1",
  label: "2.0",
  name: "review",
  description: "New API review",
  compatibility: "",
  digest: "a",
  byteLength: 10,
  requirements: { runtime: "none" as const, tools: [], software: [] },
  source: { kind: "files" as const },
  availability: { state: "available" as const, reasons: [] },
};
const pack: SkillPackage = {
  packageId: "p1",
  ownerUserId: "me",
  versions: [version, { ...version, versionId: "v1", description: "Legacy database review" }],
  installations: [{ scope: { kind: "personal" }, versionId: "v1", enabled: false, revision: "1" }],
};
it("searches the installed version and includes disabled installations", () => {
  expect(matchesSkill(pack, "database REVIEW", true)).toBe(true);
  expect(matchesSkill(pack, "database", false)).toBe(false);
  expect(matchesSkill(pack, "API", false)).toBe(true);
  expect(matchesSkill({ ...pack, installations: [] }, "", true)).toBe(false);
});
it("does not confuse personal/organization or different project installs", () => {
  expect(sameSkillScope({ kind: "personal" }, { kind: "tenant" })).toBe(false);
  expect(
    sameSkillScope({ kind: "project", projectId: "a" }, { kind: "project", projectId: "b" }),
  ).toBe(false);
  expect(
    sameSkillScope({ kind: "project", projectId: "a" }, { kind: "project", projectId: "a" }),
  ).toBe(true);
});
it("previews UTF-8 instructions and recognizes binary assets without changing bytes", () => {
  const source = "---\r\nname: skill\r\n---\r\n# 技能\n保留步骤";
  expect(skillText({ path: "SKILL.md", base64: skillBase64(source) })).toBe(source);
  expect(skillBody(source)).toBe("# 技能\n保留步骤");
  expect(
    skillText({ path: "image", base64: skillBase64(Uint8Array.from([255, 0, 128])) }),
  ).toBeNull();
});
