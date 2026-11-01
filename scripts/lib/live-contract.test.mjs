import { expect, it } from "vitest";
import { validateLiveContract } from "./live-contract.mjs";

const input = {
  migrations: { "205_example": {}, "206_example": {} },
  databaseSchema: "206_example",
  deployment: {
    formatVersion: 1,
    revision: "fixture-revision",
    contracts: { schema: "206_example", modelRuntimeSnapshot: 1 },
  },
  requiredContracts: { modelRuntimeSnapshot: 1 },
};
it("matches source, PG and the recorded serving contract rather than a driver-local migration number", () => {
  expect(validateLiveContract(input).schema).toBe("206_example");
  const migrations = { ...input.migrations, "207_next": {} };
  expect(() => validateLiveContract({ ...input, migrations })).toThrow("source schema");
  expect(
    validateLiveContract({
      ...input,
      migrations,
      databaseSchema: "207_next",
      deployment: {
        ...input.deployment,
        contracts: { schema: "207_next", modelRuntimeSnapshot: 1 },
      },
    }).schema,
  ).toBe("207_next");
});
it("retains fail-closed schema, manifest and required-capability checks", () => {
  expect(() => validateLiveContract({ ...input, databaseSchema: "195_old" })).toThrow(
    "source schema",
  );
  expect(() =>
    validateLiveContract({
      ...input,
      deployment: { ...input.deployment, contracts: { schema: "205_old" } },
    }),
  ).toThrow("manifest");
  expect(() =>
    validateLiveContract({ ...input, requiredContracts: { modelRuntimeSnapshot: 2 } }),
  ).toThrow("Required live contract changed");
  expect(() =>
    validateLiveContract({ ...input, requiredContracts: { controlPlaneReplacement: 1 } }),
  ).toThrow("Required live contract changed");
});
