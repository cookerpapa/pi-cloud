import { expect, it, vi } from "vitest";
import { createSkillTools } from "../src/ordinary-tools/skill-tools.ts";
import type { SkillMarketService } from "../src/skill-market-service.ts";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
it("reads instructions without placement, paginates large Unicode catalogs and prepares only installed versions", async () => {
  const versions = Array.from({ length: 30 }, (_, i) => ({
    versionId: String(i).padStart(4, "0"),
    packageId: "pack",
    name: "test",
    label: "v1",
    description: "说明".repeat(512),
    digest: "a".repeat(64),
    requirements: { tools: [], runtime: "none", software: Array(64).fill("软件".repeat(100)) },
    source: { kind: "files" },
  }));
  const service = {
    runCatalog: async () => versions,
    runCapabilities: async () => ({ runtime: "linux", tools: [] }),
    content: async () => ({
      name: "test",
      files: [{ path: "SKILL.md", base64: Buffer.from("正文".repeat(10000)).toString("base64") }],
      requirements: versions[0]!.requirements,
    }),
  } as unknown as SkillMarketService;
  const prepare = vi.fn(async () => ({ path: "/workspace/.pi-cloud/skills/test" }));
  const [reader, installer] = createSkillTools(service, prepare);
  const call = (args: Record<string, unknown>) =>
    ({
      scope: { tenantId: "tenant", runId: "run" },
      arguments: args,
      bindingId: "binding",
    }) as unknown as AcceptedControlToolCommand;
  const list = await reader!.execute(call({ action: "list" }), () => true);
  const text = list.result.content[0]! as { type: "text"; text: string };
  expect(Buffer.byteLength(text.text)).toBeLessThan(32768);
  expect(JSON.parse(text.text).nextCursor).not.toBeNull();
  const page = await reader!.execute(call({ action: "read", versionId: "0000" }), () => true);
  const value = (page.result.content[0]! as { text: string }).text;
  expect(Buffer.byteLength(value)).toBeLessThan(32768);
  expect(JSON.parse(value).nextOffset).toBeGreaterThan(0);
  expect(prepare).not.toHaveBeenCalled();
  expect((await installer!.execute(call({ versionId: "missing" }), () => true)).isError).toBe(true);
  expect(prepare).not.toHaveBeenCalled();
  await installer!.execute(call({ versionId: "0000" }), () => true);
  expect(prepare).toHaveBeenCalledOnce();
});
