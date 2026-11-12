import {
  skillAvailability,
  skillActivationNeedsWorkspace,
  selectRunSkill,
  SkillRequirementsSchema,
  UuidSchema,
  type SkillPackageContent,
  type SkillRequirements,
  type SkillFile,
} from "@pi-cloud/protocol";
import type { RegisteredControlTool } from "../control-tool-registry.ts";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
import { ControlPlaneStoreError } from "../control-plane-store-error.ts";
import { SandboxControlError } from "@pi-cloud/sandbox-control/provider";
import { SandboxControlClientError } from "@pi-cloud/sandbox-control/client";
import type { SkillMarketService } from "../skill-market-service.ts";

const string = { type: "string" };
export function createSkillTools(
  service: SkillMarketService,
  prepare: (
    call: AcceptedControlToolCommand,
    content: SkillPackageContent,
    digest: string,
    signal: AbortSignal,
  ) => Promise<{ path: string }>,
  exportPackage: (
    call: AcceptedControlToolCommand,
    path: string,
    signal: AbortSignal,
  ) => Promise<{ files: SkillFile[] }>,
): RegisteredControlTool[] {
  const inspectSkill: RegisteredControlTool["execute"] = async (call, current, signal) => {
    const actor = await service.runActor(call.scope.tenantId, call.scope.runId);
    let result: unknown;
    if (typeof call.arguments.packageId === "string") {
      if (call.arguments.versionId !== undefined)
        return error("Use packageId for installation status or versionId for file preview.");
      const installations = await service.personalInstallationsForRun(
        call.scope.tenantId,
        call.scope.runId,
        [call.arguments.packageId],
      );
      result = {
        packageId: call.arguments.packageId,
        personalInstallation: installations[0] ?? null,
        currentRunSelectionUnchanged: true,
        note: "This reports your personal installation only. Organization/project installations are unchanged.",
      };
    } else if (typeof call.arguments.versionId === "string") {
      const content = await service.content(actor.tenantId, call.arguments.versionId, signal);
      const path = typeof call.arguments.path === "string" ? call.arguments.path : "SKILL.md";
      const file = content.files.find((f) => f.path === path);
      if (!file) return error("The package does not contain that path.");
      const offset = typeof call.arguments.offset === "number" ? call.arguments.offset : 0;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(file.base64, "base64"));
      } catch {
        return error("Binary resources need an installed Skill activation or a file download.");
      }
      if (offset > text.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? "")))
        return error("Invalid text offset.");
      let page = text.slice(offset, offset + 8192);
      while (Buffer.byteLength(page) > 8192) page = page.slice(0, Math.floor(page.length * 0.75));
      if (/[\uD800-\uDBFF]/.test(page.at(-1) ?? "")) page = page.slice(0, -1);
      result = {
        versionId: call.arguments.versionId,
        path,
        text: page,
        nextOffset: offset + page.length < text.length ? offset + page.length : null,
      };
    } else {
      const catalog = await service.inspect(
        actor.tenantId,
        actor.userId,
        call.arguments.name as string | undefined,
        call.arguments.cursor as string | undefined,
      );
      const installations = await service.personalInstallationsForRun(
        call.scope.tenantId,
        call.scope.runId,
        catalog.skills.map((s) => s.packageId),
      );
      result = {
        ...catalog,
        skills: catalog.skills.map((entry) => ({
          ...entry,
          personalInstallation: installations.find((i) => i.packageId === entry.packageId) ?? null,
        })),
      };
    }
    if (!current()) throw Error("Skill inspector owner changed");
    return { result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
  };
  const readSkill: RegisteredControlTool["execute"] = async (call, current, outer) => {
    const signal = outer ?? new AbortController().signal;
    const input = call.arguments as {
      action: string;
      name?: string;
      versionId?: string;
      path?: string;
      cursor?: string;
      offset?: number;
      fileOffset?: number;
      softwareOffset?: number;
    };
    const catalog = (await service.runCatalog(call.scope.tenantId, call.scope.runId)).sort((a, b) =>
      a.versionId.localeCompare(b.versionId),
    );
    if (!current()) throw new Error("Skill Tool owner changed");
    if (input.action === "list") {
      const candidates = catalog.filter((v) => !input.cursor || v.versionId > input.cursor);
      const installations = await service.personalInstallationsForRun(
        call.scope.tenantId,
        call.scope.runId,
        candidates.slice(0, 20).map((v) => v.packageId),
      );
      const context = await service.runCapabilities(
        call.scope.tenantId,
        call.scope.runId,
        call.conversationId,
      );
      const selected: unknown[] = [];
      let length = 0,
        last: string | undefined;
      for (const value of candidates) {
        const availability = skillAvailability(value.requirements, context);
        const item = {
          packageId: value.packageId,
          versionId: value.versionId,
          name: value.name,
          description: value.description,
          label: value.label,
          personalInstallation: installations.find((i) => i.packageId === value.packageId) ?? null,
          availability: {
            state: availability.state,
            reasons: availability.reasons.slice(0, 8),
            additionalReasons: Math.max(0, availability.reasons.length - 8),
          },
        };
        const bytes = Buffer.byteLength(JSON.stringify(item));
        if (selected.length && (selected.length >= 20 || length + bytes > 24000)) break;
        selected.push(item);
        length += bytes;
        last = value.versionId;
      }
      return {
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                skills: selected,
                nextCursor: selected.length < candidates.length ? last : null,
              }),
            },
          ],
        },
      };
    }
    const selected = selectRunSkill(catalog, input);
    const content = await service.content(call.scope.tenantId, selected.versionId, signal);
    const path = input.path ?? "SKILL.md";
    const file = content.files.find((f) => f.path === path);
    if (!file) return error("The package does not contain that path.");
    let directory: string | undefined;
    if (skillActivationNeedsWorkspace(selected, input as Record<string, unknown>)) {
      const capabilities = await service.runCapabilities(
        call.scope.tenantId,
        call.scope.runId,
        call.conversationId,
      );
      if (skillAvailability(selected.requirements, capabilities).state === "unsupported")
        return error("This conversation does not provide the required Skill capabilities.");
      if (!call.bindingId || !current())
        return error("The Skill execution environment is unavailable.");
      directory = (await prepare(call, content, selected.digest, signal)).path;
      if (!current()) throw new Error("Skill owner changed during activation");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(file.base64, "base64"));
    } catch {
      return directory
        ? {
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    versionId: selected.versionId,
                    directory,
                    path,
                    binary: true,
                  }),
                },
              ],
            },
          }
        : error(
            "This is a binary asset. Activate its SKILL.md to obtain the Workspace resource directory.",
          );
    }
    const offset = input.offset ?? 0;
    if (offset > text.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? "")))
      return error("Invalid text offset.");
    let page = text.slice(offset, offset + 8192);
    while (Buffer.byteLength(page) > 8192) page = page.slice(0, Math.floor(page.length * 0.75));
    if (/[\uD800-\uDBFF]/.test(page.at(-1) ?? "")) page = page.slice(0, -1);
    const fileOffset = input.fileOffset ?? 0;
    const paths: string[] = [];
    let pathBytes = 0;
    for (const file of content.files.slice(fileOffset)) {
      const length = Buffer.byteLength(file.path);
      if (paths.length >= 20 || pathBytes + length > 8192) break;
      paths.push(file.path);
      pathBytes += length;
    }
    const softwareOffset = input.softwareOffset ?? 0;
    return {
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...(directory ? { directory } : {}),
              packageId: selected.packageId,
              name: selected.name,
              versionId: selected.versionId,
              digest: selected.digest,
              source: selected.source,
              requirements: {
                runtime: selected.requirements.runtime,
                tools: selected.requirements.tools,
                software: selected.requirements.software.slice(softwareOffset, softwareOffset + 8),
              },
              nextSoftwareOffset:
                softwareOffset + 8 < selected.requirements.software.length
                  ? softwareOffset + 8
                  : null,
              path,
              text: page,
              nextOffset: offset + page.length < text.length ? offset + page.length : null,
              files: paths,
              nextFileOffset:
                fileOffset + paths.length < content.files.length ? fileOffset + paths.length : null,
            }),
          },
        ],
      },
    };
  };
  const tools: RegisteredControlTool[] = [
    {
      definition: {
        name: "publish_skill",
        environment: { kind: "workspace" },
        availability: "root",
        description:
          "Publish a Skill directory from this Workspace to the organization's Skill market. First create SKILL.md with YAML name and description plus Markdown instructions using ordinary write/edit tools, add only necessary scripts/references/assets, and verify the workflow. path points to that directory. packageId updates a package you own; otherwise the same owner/name is reused. version is an optional display label; omitted labels derive from the content. requirements declares runtime/tools/software when needed. Complete file bytes are collected by the platform, not from truncated Tool output. Identical content reuses its published version. Publishing does not install the Skill for anyone or change this Run's frozen selection. If a reply is lost, skill(action=inspect) can check the published catalog before another intentional publish.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4096 },
            packageId: JSON.parse(JSON.stringify(UuidSchema)),
            version: { type: "string", minLength: 1, maxLength: 100 },
            requirements: JSON.parse(JSON.stringify(SkillRequirementsSchema)),
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      replay: "never",
      async execute(call, current, outer) {
        const signal = outer ?? new AbortController().signal;
        if (!call.bindingId || !current())
          return error("The publication Workspace is unavailable.");
        const actor = await service.runActor(call.scope.tenantId, call.scope.runId, {
          sessionId: call.scope.sessionId,
          conversationId: call.conversationId,
        });
        const { files } = await exportPackage(call, call.arguments.path as string, signal);
        if (!current()) throw Error("Skill publisher changed during export");
        const input = call.arguments as {
          packageId?: string;
          version?: string;
          requirements?: SkillRequirements;
        };
        const hasScripts = files.some(
          (file) => file.path.startsWith("scripts/") || /\.(py|sh|js|mjs|cjs|ts)$/i.test(file.path),
        );
        const version = await service.publish(
          actor,
          {
            ...(input.packageId ? { packageId: input.packageId } : {}),
            ...(input.version ? { label: input.version } : {}),
            requirements: input.requirements ?? {
              runtime: hasScripts ? "linux" : "none",
              tools: hasScripts ? ["bash"] : [],
              software: [],
            },
            source: { kind: "files", files },
          },
          signal,
        );
        if (!current())
          throw Error("Skill publication completed after its caller stopped; inspect the catalog");
        return {
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  packageId: version.packageId,
                  versionId: version.versionId,
                  name: version.name,
                  version: version.label,
                  digest: version.digest,
                  published: true,
                  installed: false,
                }),
              },
            ],
          },
        };
      },
    },
    {
      definition: {
        name: "skill",
        environment: { kind: "skill" },
        description:
          "Use Skills. action=list shows this Run's frozen installed selection and exact personal installation revisions. action=read loads SKILL.md or a package-relative reference by the advertised name (versionId only disambiguates); execution resources are prepared automatically and their Workspace directory is returned, without executing scripts. Follow continuation offsets. action=inspect previews published organization versions without activation; packageId queries the current personal installation, including after an uncertain uninstall. action=uninstall removes only the root Session owner's personal installation using packageId and its observed revision. It never deletes published packages, other scopes, Workspace files, or this Run's frozen selection; wider installations may still apply next Run. Use publish_skill to publish a package.",
        parameters: {
          type: "object",
          properties: {
            action: { enum: ["list", "read", "inspect", "uninstall"] },
            name: string,
            versionId: string,
            path: string,
            cursor: string,
            packageId: JSON.parse(JSON.stringify(UuidSchema)),
            revision: { type: "string", pattern: "^[1-9][0-9]{0,17}$" },
            offset: { type: "integer", minimum: 0 },
            fileOffset: { type: "integer", minimum: 0 },
            softwareOffset: { type: "integer", minimum: 0 },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      replay: "never",
      async execute(call, current, signal) {
        if (call.arguments.action === "inspect") return inspectSkill(call, current, signal);
        if (call.arguments.action === "uninstall") {
          const { packageId, revision } = call.arguments;
          if (
            typeof packageId !== "string" ||
            typeof revision !== "string" ||
            !/^[1-9][0-9]{0,17}$/.test(revision)
          )
            return error(
              "Use the packageId and personal installation revision from skill(action=list or inspect).",
            );
          if (!current()) throw Error("Skill uninstall caller changed");
          const actor = await service.runActor(call.scope.tenantId, call.scope.runId, {
            sessionId: call.scope.sessionId,
            conversationId: call.conversationId,
          });
          if (!current()) throw Error("Skill uninstall caller changed");
          const result = await service.uninstall(actor, packageId, { kind: "personal" }, revision);
          return {
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    packageId,
                    scope: "personal",
                    ...result,
                    effectiveFrom: "next_run",
                    currentRunSelectionUnchanged: true,
                    sharedInstallationsUnchanged: true,
                    publishedPackageRetained: true,
                    workspaceFilesRetained: true,
                    note: "Project or organization installations may still apply. Inspect current installation state after an uncertain result.",
                  }),
                },
              ],
            },
          };
        }
        if (call.arguments.action !== "read" && call.arguments.action !== "list")
          return error("Unknown Skill action.");
        return readSkill(call, current, signal);
      },
    },
  ];
  // Safe, actionable errors reach the Agent; no package content/credentials in logs.
  return tools.map((tool) => ({
    ...tool,
    execute: async (...args) => {
      try {
        return await tool.execute(...args);
      } catch (cause) {
        if (args[2]?.aborted) throw cause;
        return error(
          cause instanceof TypeError ||
            cause instanceof ControlPlaneStoreError ||
            cause instanceof SandboxControlError ||
            cause instanceof SandboxControlClientError
            ? cause.message
            : "Skill operation could not be confirmed. Use skill(action=inspect) to check publication before retrying; verify storage and the Workspace if needed.",
        );
      }
    },
  }));
}
function error(text: string) {
  return {
    isError: true,
    result: { content: [{ type: "text" as const, text: `skill_unavailable: ${text}` }] },
  };
}
