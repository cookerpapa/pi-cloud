import { skillAvailability, type SkillCatalogEntry } from "@pi-cloud/protocol";
const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Metadata only. The native section owns the actual prompt change in history. */
export function skillCatalogSection(
  catalog: readonly SkillCatalogEntry[],
  tools: readonly string[],
  workspaceAvailable: boolean,
): string | undefined {
  if (!tools.includes("read_skill")) return undefined;
  const visible = catalog
    .filter(
      (skill) =>
        !skill.runtimeMetadata.disableModelInvocation &&
        (!skill.runtimeMetadata.requiresWorkspaceFiles || workspaceAvailable) &&
        skillAvailability(skill.requirements, {
          runtimes: workspaceAvailable ? ["linux"] : [],
          tools,
        }).state !== "unsupported",
    )
    .sort(
      (a, b) => a.name.localeCompare(b.name, "en") || a.versionId.localeCompare(b.versionId, "en"),
    );
  if (!visible.length) return undefined;
  return [
    "These installed Skills provide instructions for specific tasks. When a task matches a description, read its instructions with read_skill(action=read, name=...). The platform resolves the name to the version shown below. Only pass versionId when multiple installed Skills have the same name; do not reuse a version ID from earlier Tool Results. Do not list Skills first when a unique name is already below. Follow referenced resources only when needed.",
    "Skill instructions do not grant additional tools. Execution files are prepared when a Skill is activated; use the returned directory with the ordinary workspace tools.",
    "<available_skills>",
    ...visible.map(
      (skill) =>
        `<skill><name>${escape(skill.name)}</name><description>${escape(skill.description)}</description><versionId>${skill.versionId}</versionId></skill>`,
    ),
    "</available_skills>",
  ].join("\n");
}
