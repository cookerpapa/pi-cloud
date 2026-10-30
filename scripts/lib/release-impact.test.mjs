import { expect, it } from "vitest";
import { releaseImpact, catalogSeed } from "./release-impact.mjs";
it("builds only the Control Plane for ordinary tools and rejects mixed runtime changes", () => {
  const tool = "packages/control-plane/src/ordinary-tools/registry.ts";
  expect(
    releaseImpact([tool, "packages/control-plane/test/new-tool.test.ts"]).matrix.include.map(
      (i) => i.image,
    ),
  ).toEqual(["control-plane"]);
  expect(releaseImpact([tool]).scope).toBe("control-plane");
  for (const changed of [
    "packages/control-plane/src/main.ts",
    "packages/control-plane/src/control-tool-dispatcher.ts",
    "packages/protocol/src/index.ts",
    "package-lock.json",
  ])
    expect(releaseImpact([tool, changed]).scope).toBe("full");
});
it("uses narrow model gates and no unrelated images", () => {
  expect(releaseImpact([catalogSeed])).toEqual({
    scope: "catalog",
    matrix: { include: [] },
    buildImages: false,
  });
  const provider = releaseImpact(["deploy/provider-gateway/Dockerfile", "docs/README.md"]);
  expect(provider.scope).toBe("provider");
  expect(provider.matrix.include.map((i) => i.image)).toEqual(["cli-proxy-api"]);
  expect(releaseImpact(["deploy/provider-gateway/model_sessions.go"]).scope).toBe("provider");
  expect(
    releaseImpact([
      "deploy/provider-gateway/model_sessions.patch",
      "scripts/lib/component-release.mjs",
    ]).matrix.include.map((i) => i.image),
  ).toEqual(["cli-proxy-api"]);
  const both = releaseImpact([catalogSeed, "deploy/provider-gateway/Dockerfile"]);
  expect(both.scope).toBe("catalog");
  expect(both.matrix.include).toHaveLength(1);
  expect(releaseImpact(["scripts/run-component-release.mjs"]).buildImages).toBe(false);
});
it("keeps missing history and runtime/schema/dependency/workflow changes on full checks", () => {
  for (const files of [
    undefined,
    [],
    ["packages/protocol/src/index.ts"],
    ["package-lock.json"],
    [".github/workflows/ci.yml"],
    ["packages/control-plane/test/run-queue.test.ts"],
  ]) {
    const result = releaseImpact(files);
    expect(result.scope).toBe("full");
    expect(result.matrix.include).toHaveLength(10);
  }
  expect(releaseImpact(["docs/README.md"]).scope).toBe("docs");
});
