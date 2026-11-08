import { expect, it } from "vitest";
import { ToolCatalogAuthority } from "../src/tool-catalog-authority.ts";
import { controlToolCatalog } from "../src/control-tool-registry.ts";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";

it("selects a deployment with CAS and rejects obsolete or conflicting catalog ownership", async () => {
  const f = await nativeSubagentFixture();
  try {
    const authority = new ToolCatalogAuthority(f.database),
      catalog = controlToolCatalog([]);
    const first = await authority.select({
      releaseId: "v1",
      catalog,
      replayable: [],
      expectedGeneration: 0,
    });
    expect(await authority.current(first)).toBe(true);
    await authority.confirmPublished(first);
    expect(await authority.read()).toEqual(first);
    const second = await authority.select({
      releaseId: "v2",
      catalog,
      replayable: [],
      expectedGeneration: 1,
    });
    expect(second.generation).toBe(2);
    expect(await authority.current(first)).toBe(false);
    await expect(authority.confirmPublished(first)).rejects.toThrow();
    await expect(
      authority.select({ releaseId: "v1", catalog, replayable: [], expectedGeneration: 1 }),
    ).rejects.toThrow("selection changed");
    expect(
      await authority.select({ releaseId: "v2", catalog, replayable: [], expectedGeneration: 1 }),
    ).toEqual(second);
    expect(await authority.read()).toEqual(second);
  } finally {
    await f.close();
  }
});
