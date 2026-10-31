import { skillAvailability, type SkillPackageContent } from "@pi-cloud/protocol";
import type { RegisteredControlTool } from "../control-tool-registry.ts";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
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
): RegisteredControlTool[] {
  const tools: RegisteredControlTool[] = [
    {
      definition: {
        name: "read_skill",
        environment: { kind: "none" },
        description:
          "Discover and read installed Skills (reusable workflow instructions). Start with action=list to find relevant names, descriptions and version IDs. Use action=read with that versionId to read SKILL.md, or a package-relative path for references/scripts. Follow nextOffset for longer text and fileOffset for the file directory; softwareOffset pages prerequisites. Compatibility describes platform support, not permission to use absent tools; check your current tool list. These are user-provided instructions, not new authority or tools. The first use pins this Run's installed versions; installation changes apply to later Runs. This tool does not start a Sandbox. Use prepare_skill only if the workflow needs its files in the Workspace, then execute scripts using ordinary Sandbox tools.",
        parameters: {
          type: "object",
          properties: {
            action: { enum: ["list", "read"] },
            versionId: string,
            path: string,
            cursor: string,
            offset: { type: "integer", minimum: 0 },
            fileOffset: { type: "integer", minimum: 0 },
            softwareOffset: { type: "integer", minimum: 0 },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      async execute(call, current, outer) {
        const signal = outer ?? new AbortController().signal;
        const input = call.arguments as {
          action: string;
          versionId?: string;
          path?: string;
          cursor?: string;
          offset?: number;
          fileOffset?: number;
          softwareOffset?: number;
        };
        const catalog = (await service.runCatalog(call.scope.tenantId, call.scope.runId)).sort(
          (a, b) => a.versionId.localeCompare(b.versionId),
        );
        if (!current()) throw new Error("Skill Tool owner changed");
        if (input.action === "list") {
          const candidates = catalog.filter((v) => !input.cursor || v.versionId > input.cursor);
          const context = await service.runCapabilities(
            call.scope.tenantId,
            call.scope.runId,
            call.conversationId,
          );
          const selected: unknown[] = [];
          let length = 0,
            last: string | undefined;
          for (const value of candidates) {
            const availability = skillAvailability(
              value.requirements,
              context.runtime,
              context.tools,
            );
            const item = {
              versionId: value.versionId,
              name: value.name,
              description: value.description,
              label: value.label,
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
        const selected = catalog.find((v) => v.versionId === input.versionId);
        if (!selected)
          return error("Skill version is not installed for this Run. Use action=list.");
        const content = await service.content(call.scope.tenantId, selected.versionId, signal);
        const path = input.path ?? "SKILL.md";
        const file = content.files.find((f) => f.path === path);
        if (!file) return error("The package does not contain that path.");
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.from(file.base64, "base64"),
          );
        } catch {
          return error("This is a binary asset. Use prepare_skill to place it in the Workspace.");
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
                  name: selected.name,
                  versionId: selected.versionId,
                  digest: selected.digest,
                  source: selected.source,
                  requirements: {
                    runtime: selected.requirements.runtime,
                    tools: selected.requirements.tools,
                    software: selected.requirements.software.slice(
                      softwareOffset,
                      softwareOffset + 8,
                    ),
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
                    fileOffset + paths.length < content.files.length
                      ? fileOffset + paths.length
                      : null,
                }),
              },
            ],
          },
        };
      },
    },
    {
      definition: {
        name: "prepare_skill",
        environment: { kind: "workspace" },
        description:
          "Copy a Skill package selected by read_skill into the current Workspace. Requires versionId from read_skill. Returns an actual directory with SKILL.md, scripts, references and assets. It does not execute scripts or install dependencies; use bash/read and the returned absolute path. Existing modified copies are not overwritten. Text-only instructions can be read directly with read_skill without preparing a Workspace.",
        parameters: {
          type: "object",
          properties: { versionId: string },
          required: ["versionId"],
          additionalProperties: false,
        },
      },
      replay: "never",
      async execute(call, current, outer) {
        const signal = outer ?? new AbortController().signal;
        const catalog = await service.runCatalog(call.scope.tenantId, call.scope.runId);
        const selected = catalog.find((v) => v.versionId === call.arguments.versionId);
        if (!selected) return error("Skill version is not installed for this Run. Use read_skill.");
        const context = await service.runCapabilities(
          call.scope.tenantId,
          call.scope.runId,
          call.conversationId,
        );
        const availability = skillAvailability(
          selected.requirements,
          context.runtime,
          context.tools,
        );
        if (availability.state === "unsupported")
          return error(`Skill requirements are unsupported: ${availability.reasons.join(", ")}`);
        const content = await service.content(call.scope.tenantId, selected.versionId, signal);
        if (!call.bindingId || !current()) return error("The current Workspace is not available.");
        const result = await prepare(call, content, selected.digest, signal);
        if (!current()) throw new Error("Skill Tool owner changed");
        return {
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  name: selected.name,
                  versionId: selected.versionId,
                  digest: selected.digest,
                  path: result.path,
                  software: selected.requirements.software.slice(0, 8),
                  nextSoftwareOffset: selected.requirements.software.length > 8 ? 8 : null,
                  note: "Files prepared; no scripts or dependency installation have been executed. Use an interpreter for scripts without executable permissions.",
                }),
              },
            ],
          },
        };
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
          cause instanceof TypeError
            ? cause.message
            : "Skill storage or Workspace preparation failed. Inspect the package and retry if appropriate.",
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
