import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { RuntimeModelCatalog, freezeModelRuntime } from "../src/runtime-model-catalog.ts";
import { fixtureModelCatalog } from "../../../scripts/lib/test-model-catalog.mjs";

it("atomically adopts file replacements, retains last valid data and leaves frozen Runs untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-catalog-")),
    path = join(dir, "catalog.json");
  let now = 0;
  const write = (value: unknown) => {
    writeFileSync(path + ".next", JSON.stringify(value));
    renameSync(path + ".next", path);
  };
  try {
    write(fixtureModelCatalog);
    const loader = new RuntimeModelCatalog(path, 1000, () => now),
      before = loader.read();
    const frozen = freezeModelRuntime(before.configuration.models[1]!, before);
    const next = structuredClone(fixtureModelCatalog);
    next.models[1]!.maxTokens = 32768;
    write(next);
    expect(loader.read()).toBe(before);
    now = 1000;
    expect(loader.read().revision).not.toBe(before.revision);
    expect(frozen.maxTokens).toBe(65536);
    const accepted = loader.read();
    write({ broken: true });
    now = 2000;
    expect(loader.read()).toBe(accepted);
    expect(loader.status().reloadFailed).toBe(true);
    expect(() => new RuntimeModelCatalog(path)).toThrow();
    write(fixtureModelCatalog);
    now = 3000;
    expect(loader.status()).toEqual({ revision: before.revision, reloadFailed: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
