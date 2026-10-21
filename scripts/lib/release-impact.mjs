export const catalogSeed = "deploy/helm/pi-cloud-platform/files/model-catalog.json";
export const operatorSources = new Set([
  "scripts/run-component-release.mjs",
  "scripts/run-release-scope-check.mjs",
  "scripts/run-live-component-release-check.mjs",
  "scripts/lib/component-release.mjs",
  "scripts/lib/release-lock.mjs",
  "scripts/lib/model-catalog-probe.mjs",
  "scripts/generate-release-evidence.mjs",
  "scripts/lib/release-image-evidence.mjs",
  "scripts/release-impact.mjs",
  "scripts/lib/release-impact.mjs",
]);
export const modelTests = new Set([
  "scripts/lib/component-release.test.mjs",
  "scripts/lib/model-catalog-probe.test.mjs",
  "scripts/lib/release-impact.test.mjs",
  "scripts/lib/release-image-evidence.test.mjs",
  "scripts/lib/matched-release.test.mjs",
  "scripts/lib/guest-build-identity.test.mjs",
  "packages/protocol/test/model-catalog.test.ts",
  "packages/supervisor-host/test/model-gateway.test.ts",
  "packages/control-plane/test/runtime-model-catalog.test.ts",
  "packages/control-plane/test/model-catalog-snapshot.postgres.test.ts",
  "packages/control-plane/test/tenant-model-configuration.test.ts",
  "packages/web-ui/test/model-settings-menu.test.ts",
  "packages/web-ui/test/api.test.ts",
]);
const fullImages = [
  ["control-plane", "packages/control-plane/Dockerfile"],
  ["supervisor-host", "packages/supervisor-host/Dockerfile"],
  ["workspace-volume-gateway", "packages/sandbox-control/Dockerfile.volume-gateway"],
  ["web-ui", "packages/web-ui/Dockerfile"],
  ["provider-egress-relay", "packages/provider-egress-relay/Dockerfile"],
  ["cube-api-authorizer", "packages/cube-api-authorizer/Dockerfile"],
  ["cube-egress-gateway", "packages/cube-egress-gateway/Dockerfile"],
  ["ssh-gateway", "packages/ssh-gateway/Dockerfile"],
  ["cubesandbox-tool", "deploy/cubesandbox/Dockerfile.tool"],
  ["cli-proxy-api", "deploy/provider-gateway/Dockerfile"],
].map(([image, dockerfile]) => ({ image, dockerfile }));
const documentation = (file) => file === "README.md" || file.startsWith("docs/");
export function releaseImpact(files) {
  const full = () => ({ scope: "full", matrix: { include: fullImages }, buildImages: true });
  if (!files?.length) return full();
  if (files.every(documentation))
    return { scope: "docs", matrix: { include: [] }, buildImages: false };
  if (
    files.some(
      (file) =>
        !documentation(file) &&
        file !== catalogSeed &&
        file !== "deploy/provider-gateway/Dockerfile" &&
        !operatorSources.has(file) &&
        !modelTests.has(file),
    )
  )
    return full();
  const provider = files.includes("deploy/provider-gateway/Dockerfile");
  const scope =
    provider &&
    files.every((file) => documentation(file) || file === "deploy/provider-gateway/Dockerfile")
      ? "provider"
      : "catalog";
  return { scope, matrix: { include: provider ? [fullImages.at(-1)] : [] }, buildImages: provider };
}
