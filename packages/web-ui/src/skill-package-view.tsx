import type { SkillMarket, SkillScope, SkillFile } from "@pi-cloud/protocol";
export type SkillPackage = SkillMarket["packages"][number];
export const sameSkillScope = (a: SkillScope, b: SkillScope) =>
  a.kind === b.kind &&
  (a.kind !== "project" || (b.kind === "project" && a.projectId === b.projectId));
export const skillInstallation = (pack: SkillPackage, scope: SkillScope) =>
  pack.installations.find((value) => sameSkillScope(value.scope, scope));
export function matchesSkill(pack: SkillPackage, query: string, installed: boolean) {
  if (installed && !pack.installations.length) return false;
  const versions = installed
    ? pack.versions.filter((v) => pack.installations.some((i) => i.versionId === v.versionId))
    : pack.versions.slice(0, 1);
  const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return versions.some((version) =>
    words.every((word) =>
      `${version.name} ${version.description}`.toLocaleLowerCase().includes(word),
    ),
  );
}
export function skillBytes(file: SkillFile): Uint8Array {
  return Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
}
export function skillText(file: SkillFile): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(skillBytes(file));
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}
export function skillBase64(text: string | Uint8Array) {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  let value = "";
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
export const skillBody = (text: string) =>
  text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
export function downloadSkill(name: string, bytes: BlobPart) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
