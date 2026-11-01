import type { Context } from "@earendil-works/chord";
import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  MemoryStorage,
  type StorageWrite,
  type Seq,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@earendil-works/chord/context";
import type { SkillCatalogEntry } from "@pi-cloud/protocol";
import { skillCatalogSection } from "../src/durable/skill-context.ts";
import { DurableAgentSession, type DurableRunConfiguration } from "../src/durable/agent-session.ts";
const entry = (name = "team-review"): SkillCatalogEntry => ({
  versionId: randomUUID(),
  packageId: randomUUID(),
  name,
  description: "Use for the team's review format <team>",
  digest: "a".repeat(64),
  requirements: { runtime: "none", tools: [], software: [] },
  runtimeMetadata: { disableModelInvocation: false, requiresWorkspaceFiles: false },
});
it("renders stable escaped metadata and respects manual-only and actual child capabilities", () => {
  const text = entry(),
    script = {
      ...entry("script"),
      requirements: { runtime: "linux" as const, tools: ["bash"], software: [] },
      runtimeMetadata: { disableModelInvocation: false, requiresWorkspaceFiles: true },
    },
    manual = {
      ...entry("manual"),
      runtimeMetadata: { disableModelInvocation: true, requiresWorkspaceFiles: false },
    };
  expect(skillCatalogSection([text, script, manual], ["read_skill"], false)).toContain(
    text.versionId,
  );
  expect(skillCatalogSection([text, script, manual], ["read_skill"], false)).not.toContain(
    script.versionId,
  );
  expect(skillCatalogSection([text, script, manual], ["read_skill", "bash"], true)).not.toContain(
    manual.versionId,
  );
  expect(skillCatalogSection([text], ["read_skill"], false)).toContain("&lt;team&gt;");
  expect(skillCatalogSection([text, script], ["read_skill", "bash"], true)).toBe(
    skillCatalogSection([script, text], ["read_skill", "bash"], true),
  );
  expect(skillCatalogSection([text], [], true)).toBeUndefined();
});
class Journal extends MemoryStorage {
  readonly commits: StorageWrite[][] = [];
  override async commit(writes: readonly StorageWrite[], _ctx: Context): Promise<Seq> {
    const prepared = this.prepareCommit(writes);
    this.commits.push(structuredClone([...writes]));
    return prepared.apply();
  }
}
it("native Pi announces the catalog before a Tool, persists its system section and restores the same selection", async () => {
  const models = createModels(),
    provider = fauxProvider({ tokensPerSecond: 1000000 });
  models.setProvider(provider.provider);
  const skill = entry(),
    runId = randomUUID(),
    started = Promise.withResolvers<void>();
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read_skill", { action: "read", versionId: skill.versionId }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Recovered"),
  ]);
  const inputs: unknown[] = [];
  const tool: ToolRegistration = {
    name: "read_skill",
    description: "Load selected instructions",
    parameters: Type.Object({ action: Type.Literal("read"), versionId: Type.String() }),
    execute: async (_args, _api, ctx) => {
      started.resolve();
      await awaitWithContext(new Promise(() => {}), ctx);
      return { content: [{ type: "text", text: "BODY_NOT_LOADED" }] };
    },
  };
  const config = (): DurableRunConfiguration => ({
    runId,
    conversationId: 1,
    model: provider.getModel(),
    agent: {},
    context: {},
    skillCatalog: [skill],
    workspaceAvailable: false,
    tools: [tool],
    remoteTools: () => [],
    assertCurrent: async () => {},
    prepareRemote: async () => {
      throw Error("No remote effect expected");
    },
    openModel: async (request) => {
      inputs.push(structuredClone(request.input));
      return { model: provider.getModel(), options: request.options, release() {} };
    },
  });
  const storage = new Journal();
  let runtime = await DurableAgentSession.open(storage, {
    models,
    remoteTools: [],
    infrastructureTools: [tool],
    settings: { compaction: { enabled: false } },
  });
  try {
    const root = await runtime.bind(config());
    await root.submit(
      { type: "input", content: "Use the team review format", requestId: runId },
      context,
    );
    await started.promise;
    expect(JSON.stringify(inputs[0])).toContain(skill.versionId);
    expect(JSON.stringify(inputs[0])).toContain("team-review");
    expect(JSON.stringify(inputs[0])).not.toContain("BODY_NOT_LOADED");
    const history = JSON.stringify(storage.commits);
    expect(history).toContain('"kind":"pi.system"');
    expect(history).toContain(skill.versionId);
    await runtime.close();
    const restored = new Journal();
    for (const writes of storage.commits) await restored.commit(writes, context);
    runtime = await DurableAgentSession.open(restored, {
      models,
      remoteTools: [],
      infrastructureTools: [tool],
      settings: { compaction: { enabled: false } },
    });
    await runtime.bind(config(), "reattach");
    runtime.harness.resume();
    await runtime.harness.waitForIdle(context);
    expect(inputs.length).toBeGreaterThan(1);
    expect(JSON.stringify(inputs.at(-1))).toContain(skill.versionId);
    expect(JSON.stringify(inputs.at(-1))).not.toContain("BODY_NOT_LOADED");
  } finally {
    await runtime.close();
  }
}, 15000);
