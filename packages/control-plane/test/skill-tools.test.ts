import { expect, it, vi } from "vitest";
import { createSkillTools } from "../src/ordinary-tools/skill-tools.ts";
import type { SkillMarketService } from "../src/skill-market-service.ts";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
const call = (args: Record<string, unknown>, bindingId: string | null = "binding") =>
  ({
    scope: { tenantId: "tenant", runId: "run", sessionId: "root-view" },
    conversationId: 1,
    arguments: args,
    ...(bindingId ? { bindingId } : {}),
    operationId: "op",
  }) as unknown as AcceptedControlToolCommand;
const decoded = (
  value: Awaited<ReturnType<ReturnType<typeof createSkillTools>[number]["execute"]>>,
) => JSON.parse((value.result.content[0] as { text: string }).text);
function fixture() {
  const versions = Array.from({ length: 30 }, (_, i) => ({
    versionId: String(i).padStart(4, "0"),
    packageId: "pack",
    name: "test",
    label: "v1",
    description: "说明".repeat(512),
    digest: "a".repeat(64),
    requirements: {
      tools: [] as string[],
      runtime: "none",
      software: Array(64).fill("软件".repeat(100)),
    },
    source: { kind: "files" },
    runtimeMetadata: { disableModelInvocation: false, requiresWorkspaceFiles: false },
  }));
  const service = {
    runCatalog: async () => versions,
    runCapabilities: async () => ({ runtimes: ["linux"], tools: [] }),
    runActor: vi.fn(async () => ({ tenantId: "tenant", userId: "owner", role: "member" })),
    personalInstallationsForRun: vi.fn(async () => []),
    uninstall: vi.fn(async () => ({ removed: true, absent: true })),
    inspect: vi.fn(async () => ({ skills: [], nextCursor: null })),
    publish: vi.fn(async () => ({ ...versions[0], versionId: "published" })),
    content: async () => ({
      name: "test",
      files: [
        { path: "SKILL.md", base64: Buffer.from("正文".repeat(10000)).toString("base64") },
        { path: "references/guide.md", base64: Buffer.from("Guide").toString("base64") },
      ],
      requirements: versions[0]!.requirements,
    }),
  };
  const prepare = vi.fn(async () => ({ path: "/workspace/.pi-cloud/skills/test" }));
  const exportPackage = vi.fn(async () => ({
    files: [
      { path: "SKILL.md", base64: Buffer.from("content").toString("base64") },
      { path: "scripts/test.py", base64: Buffer.from("print('ok')").toString("base64") },
    ],
  }));
  const tools = createSkillTools(service as unknown as SkillMarketService, prepare, exportPackage);
  const tool = (name: string) => tools.find((t) => t.definition.name === name)!;
  return { versions, service, prepare, exportPackage, tools, tool };
}
it("reads instructions without a VM, preserves bounded Unicode pages, and activates only execution files", async () => {
  const f = fixture(),
    reader = f.tool("skill");
  expect(f.tools.map((t) => t.definition.name)).toEqual(["publish_skill", "skill"]);
  const list = await reader.execute(call({ action: "list" }), () => true);
  expect(Buffer.byteLength((list.result.content[0] as { text: string }).text)).toBeLessThan(32768);
  expect(decoded(list).nextCursor).not.toBeNull();
  const first = await reader.execute(call({ action: "read", versionId: "0000" }, null), () => true);
  expect(decoded(first).nextOffset).toBeGreaterThan(0);
  expect(f.prepare).not.toHaveBeenCalled();
  f.versions[0]!.runtimeMetadata.requiresWorkspaceFiles = true;
  expect(
    (await reader.execute(call({ action: "read", versionId: "missing" }), () => true)).isError,
  ).toBe(true);
  expect(
    (await reader.execute(call({ action: "read", versionId: "0000" }, null), () => true)).isError,
  ).toBe(true);
  const active = await reader.execute(call({ action: "read", versionId: "0000" }), () => true);
  expect(decoded(active).directory).toContain("/workspace/");
  expect(f.prepare).toHaveBeenCalledOnce();
  await reader.execute(
    call({ action: "read", versionId: "0000", offset: decoded(active).nextOffset }, null),
    () => true,
  );
  await reader.execute(
    call({ action: "read", versionId: "0000", path: "references/guide.md" }, null),
    () => true,
  );
  expect(f.prepare).toHaveBeenCalledOnce();
});
it("keeps explicit inspection cloud-only even for execution skills", async () => {
  const f = fixture();
  f.versions[0]!.runtimeMetadata.requiresWorkspaceFiles = true;
  const result = await f
    .tool("skill")
    .execute(call({ action: "inspect", versionId: "0000" }, null), () => true);
  expect(decoded(result).text).toContain("正文");
  expect(f.prepare).not.toHaveBeenCalled();
});
it("publishes complete exported files with the originating actor and never installs them", async () => {
  const f = fixture(),
    publisher = f.tool("publish_skill");
  expect(publisher.replay).toBe("never");
  expect(publisher.definition.availability).toBe("root");
  const result = await publisher.execute(call({ path: "skills/test" }), () => true);
  expect(f.exportPackage).toHaveBeenCalledOnce();
  expect(f.service.publish).toHaveBeenCalledWith(
    { tenantId: "tenant", userId: "owner", role: "member" },
    expect.objectContaining({
      source: { kind: "files", files: expect.any(Array) },
      requirements: { runtime: "linux", tools: ["bash"], software: [] },
    }),
    expect.any(AbortSignal),
  );
  expect(decoded(result)).toMatchObject({
    published: true,
    installed: false,
    versionId: "published",
  });
});
it("returns actionable validation failures and does not publish after owner loss", async () => {
  const f = fixture();
  let current = true;
  f.exportPackage.mockImplementationOnce(async () => {
    current = false;
    return { files: [] };
  });
  const result = await f
    .tool("publish_skill")
    .execute(call({ path: "skills/test" }), () => current);
  expect(result.isError).toBe(true);
  expect(f.service.publish).not.toHaveBeenCalled();
  f.exportPackage.mockRejectedValueOnce(
    new TypeError("Skill source changed; retry after edits finish"),
  );
  const failed = await f.tool("publish_skill").execute(call({ path: "skills/test" }), () => true);
  expect((failed.result.content[0] as { text: string }).text).toContain("source changed");
});

it("loads by a unique name and requires explicit selection for duplicate names", async () => {
  const f = fixture(),
    reader = f.tool("skill");
  expect(
    (await reader.execute(call({ action: "read", name: "test" }, null), () => true)).isError,
  ).toBe(true);
  f.versions[0]!.name = "team-review";
  const result = await reader.execute(
    call({ action: "read", name: "team-review" }, null),
    () => true,
  );
  expect(decoded(result).versionId).toBe("0000");
  expect(f.prepare).not.toHaveBeenCalled();
  expect(
    (
      await reader.execute(
        call({ action: "read", name: "team-review", versionId: "0001" }, null),
        () => true,
      )
    ).isError,
  ).toBe(true);
  expect(
    decoded(
      await reader.execute(
        call({ action: "read", name: "test", versionId: "0001" }, null),
        () => true,
      ),
    ).versionId,
  ).toBe("0001");
});

it("uninstalls one exact personal installation without touching package or Workspace bytes", async () => {
  const f = fixture();
  const result = await f.tool("skill").execute(
    call(
      {
        action: "uninstall",
        packageId: "40000000-0000-4000-8000-000000000001",
        revision: "14",
      },
      null,
    ),
    () => true,
  );
  expect(f.service.runActor).toHaveBeenCalledWith("tenant", "run", {
    sessionId: "root-view",
    conversationId: 1,
  });
  expect(f.service.uninstall).toHaveBeenCalledWith(
    { tenantId: "tenant", userId: "owner", role: "member" },
    "40000000-0000-4000-8000-000000000001",
    { kind: "personal" },
    "14",
  );
  expect(decoded(result)).toMatchObject({
    removed: true,
    currentRunSelectionUnchanged: true,
    publishedPackageRetained: true,
    workspaceFilesRetained: true,
  });
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.exportPackage).not.toHaveBeenCalled();
  expect(f.service.publish).not.toHaveBeenCalled();
});

it("requires an observed installation revision and allows storage-only result inspection", async () => {
  const f = fixture(),
    skill = f.tool("skill");
  const rejected = await skill.execute(
    call({ action: "uninstall", name: "test" }, null),
    () => true,
  );
  expect(rejected.isError).toBe(true);
  expect(f.service.uninstall).not.toHaveBeenCalled();
  const inspected = await skill.execute(
    call({ action: "inspect", packageId: "pack" }, null),
    () => true,
  );
  expect(decoded(inspected).personalInstallation).toBeNull();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(skill.replay).toBe("never");
});
