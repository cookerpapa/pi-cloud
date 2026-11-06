import { expect, it } from "vitest";
import {
  assertMeteringRetainedInputs,
  retainSandboxProvenance,
  retainedSandboxComponents,
} from "./model-metering-release.mjs";

it("retains Cube only when its existing copied source and exports are unchanged", () => {
  const old = {
    "packages/protocol/src/index.ts": 'export { fixedTool } from "./tool.ts";\n',
    ".dockerignore": "*\n!packages/\n",
  };
  const next = {
    ...old,
    "packages/protocol/src/index.ts": `${old["packages/protocol/src/index.ts"]}\nexport * from "./model-metering.ts";\nexport * from "./model-billing.ts";\n`,
    "packages/protocol/src/model-metering.ts": "new host port",
    ".dockerignore": `${old[".dockerignore"]}!scripts/install-host-os-security-updates.sh\n!deploy/provider-gateway/metering.go\n`,
  };
  const copied = new Set([
    ...Object.keys(next),
    "packages/protocol/src/tool.ts",
    "packages/cube-completion/src/adapter.ts",
  ]);
  const options = {
    before: (p) => old[p] ?? null,
    after: (p) => next[p],
    copied,
    changed: Object.keys(next),
  };
  expect(() => assertMeteringRetainedInputs(options)).not.toThrow();
  for (const file of ["packages/protocol/src/tool.ts", "packages/cube-completion/src/adapter.ts"])
    expect(() => assertMeteringRetainedInputs({ ...options, changed: [file] })).toThrow(
      "retained Sandbox input",
    );
  expect(() =>
    assertMeteringRetainedInputs({
      ...options,
      after: (p) =>
        p.endsWith("index.ts") ? next[p].replace("fixedTool", "changedTool") : next[p],
    }),
  ).toThrow("exports changed");
  expect(() =>
    assertMeteringRetainedInputs({
      ...options,
      after: (p) => (p === ".dockerignore" ? `${next[p]}!secrets/\n` : next[p]),
    }),
  ).toThrow("unrelated build context");
});
it("records the actual retained images and their evidence, not newly built unused artifacts", () => {
  const baseline = {
    contracts: { completionIdentity: "old" },
    components: Object.fromEntries(
      retainedSandboxComponents.map((name) => [
        name,
        { reference: `${name}:old`, evidence: "original" },
      ]),
    ),
  };
  const candidate = {
    contracts: { completionIdentity: "new", schema: "210" },
    components: {
      ...baseline.components,
      worker: { reference: "worker:new" },
      cubelet: { reference: "cubelet:new" },
    },
  };
  const result = retainSandboxProvenance(candidate, baseline);
  expect(result.components.cubelet).toEqual(baseline.components.cubelet);
  expect(result.components.worker.reference).toBe("worker:new");
  expect(result.contracts).toEqual({ completionIdentity: "old", schema: "210" });
  expect(candidate.components.cubelet.reference).toBe("cubelet:new");
});
