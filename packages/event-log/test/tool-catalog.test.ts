import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ToolCatalogView } from "../src/tool-catalog.ts";

function snapshot(generation: number, names: string[] = []) {
  const tools = names.map((name) => ({
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    environment: { kind: "none" as const },
  }));
  return {
    version: 1 as const,
    scope: "platform" as const,
    generation,
    releaseId: `code-${generation}`,
    replayable: names,
    catalog: {
      version: 4 as const,
      tools,
      revision: createHash("sha256").update(JSON.stringify(tools)).digest("hex"),
    },
  };
}

it("restores a complete catalog and never regresses after stale publisher delivery", () => {
  const view = new ToolCatalogView();
  expect(view.ready).toBe(false);
  expect(() => view.read()).toThrow();
  view.accept(snapshot(8, ["new_tool"]));
  view.accept(snapshot(7, ["withdrawn_tool"]));
  expect(view.snapshot?.generation).toBe(8);
  expect(view.read().tools.map((t) => t.name)).toEqual(["new_tool"]);
  expect(view.replayable("withdrawn_tool")).toBe(false);
});

it("deduplicates a snapshot but rejects an equal generation with different contents", () => {
  const view = new ToolCatalogView();
  let updates = 0;
  view.subscribe(() => {
    updates++;
  });
  view.accept(snapshot(1, ["first"]));
  view.accept(snapshot(1, ["first"]));
  expect(updates).toBe(1);
  expect(() => view.accept(snapshot(1, ["second"]))).toThrow("generation");
  expect(view.read().tools[0]?.name).toBe("first");
});

it("an empty new snapshot withdraws tools and malformed data preserves the prior value", () => {
  const view = new ToolCatalogView();
  view.accept(snapshot(1, ["old_tool"]));
  const broken = snapshot(2, ["new_tool"]);
  broken.catalog.tools[0]!.description = "changed after digest";
  expect(() => view.accept(broken)).toThrow("digest");
  expect(view.read().tools[0]?.name).toBe("old_tool");
  view.accept(snapshot(2));
  expect(view.read().tools).toEqual([]);
  expect(view.replayable("old_tool")).toBe(false);
});

it("does not mistake visibility for a replay grant", () => {
  const value = snapshot(1, ["write_external"]);
  value.replayable = [];
  const view = new ToolCatalogView();
  view.accept(value);
  expect(view.read().tools).toHaveLength(1);
  expect(view.replayable("write_external")).toBe(false);
  expect(() => view.accept({ ...snapshot(2), replayable: ["missing"] })).toThrow("absent");
});
