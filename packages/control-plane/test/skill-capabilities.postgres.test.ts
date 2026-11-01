import { expect, it } from "vitest";
import { SkillMarketService } from "../src/skill-market-service.ts";
import { SubagentController } from "../src/subagent-controller.ts";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import { skillAvailability, type ControlToolCatalogDefinition } from "@pi-cloud/protocol";

it("uses accepted root/child grants and the current catalog without confusing max with missing delegation", async () => {
  const f = await nativeSubagentFixture();
  const host = new SubagentController({
    database: f.database,
    managementToken: "x".repeat(48),
    allowInsecureHttp: true,
    deliver: async (_reference, request) => {
      if (request.action === "start_conversation") return f.native.start(request);
      if (request.action === "stop_conversation")
        return f.native.stop(request.executionReference, request.requestId);
      return { accepted: true };
    },
  });
  let catalog: ControlToolCatalogDefinition[] = [
    {
      name: "read_skill",
      description: "Instructions",
      parameters: { type: "object" },
      environment: { kind: "skill" },
    },
    {
      name: "workspace_resource",
      description: "Files",
      parameters: { type: "object" },
      environment: { kind: "workspace" },
    },
    {
      name: "root_only",
      description: "Root",
      parameters: { type: "object" },
      environment: { kind: "none" },
      availability: "root",
    },
  ];
  const service = new SkillMarketService({
    database: f.database,
    catalog: () => catalog,
    maximumDepth: 1,
  });
  try {
    await f.database
      .updateTable("runs")
      .set({ thinking_level: "max" })
      .where("id", "=", f.scope.runId)
      .execute();
    const root = await service.runCapabilities(f.scope.tenantId, f.scope.runId, 1);
    expect(root.tools).toEqual(
      expect.arrayContaining([
        "read",
        "write",
        "edit",
        "bash",
        "subagent",
        "workflow",
        "root_only",
      ]),
    );
    expect(
      skillAvailability({ runtime: "none", tools: ["subagent"], software: [] }, root).state,
    ).toBe("available");
    await f.database
      .updateTable("runs")
      .set({ thinking_level: "ultra" })
      .where("id", "=", f.scope.runId)
      .execute();
    expect(await service.runCapabilities(f.scope.tenantId, f.scope.runId, 1)).toEqual(root);
    for (const workspace of [
      null,
      { tools: ["read"] },
      { tools: ["read", "write", "edit", "bash"] },
    ]) {
      const call = await f.command({ task: "Check skill capabilities", workspace });
      await host.executeTool(call, () => true);
      const child = f.children.get(call.operationId)!;
      const caps = await service.runCapabilities(
        f.scope.tenantId,
        f.scope.runId,
        child.conversationId,
      );
      expect(caps.tools).not.toContain("root_only");
      expect(caps.tools).not.toContain("subagent"); // accepted depth 1, configured maximum 1
      expect(caps.tools).toContain("contact_supervisor");
      expect(caps.tools).toContain("read_skill");
      expect(caps.runtimes).toEqual(workspace === null ? [] : ["linux"]);
      expect(caps.tools.includes("workspace_resource")).toBe(workspace !== null);
      expect(
        skillAvailability({ runtime: "linux", tools: ["bash"], software: [] }, caps).state,
      ).toBe(workspace?.tools.includes("bash") ? "available" : "unsupported");
      expect(caps.tools.includes("write")).toBe(workspace?.tools.includes("write") ?? false);
      await f.settle(call.operationId);
    }
    catalog = catalog.filter((tool) => tool.name !== "workspace_resource");
    expect((await service.runCapabilities(f.scope.tenantId, f.scope.runId, 1)).tools).not.toContain(
      "workspace_resource",
    );
    await expect(
      service.runCapabilities(f.scope.tenantId, f.scope.runId, 999999),
    ).rejects.toMatchObject({ code: "not_found" });
  } finally {
    await host.close();
    await f.close();
  }
}, 60000);
