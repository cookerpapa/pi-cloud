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
  "scripts/lib/control-plane-release.mjs",
  "scripts/run-live-control-plane-release-check.mjs",
  "scripts/run-live-android-check.mjs",
  "scripts/run-live-schedules-check.mjs",
  "scripts/run-history-layout-check.mjs",
  "scripts/run-history-window-check.mjs",
  "scripts/run-live-history-layout-check.mjs",
  "scripts/release-impact.mjs",
  "scripts/lib/release-impact.mjs",
]);
export const ordinaryControlToolSource = (file) =>
  /^packages\/control-plane\/src\/ordinary-tools\/.*\.ts$/.test(file);
export const imageReleaseTargets = {
  provider: {
    imageName: "cli-proxy-api",
    catalogKey: "provider",
    workload: "statefulset/cli-proxy-api",
    container: "cli-proxy-api",
  },
  web: {
    imageName: "web-ui",
    catalogKey: "web",
    workload: "deployment/pi-cloud-web",
    container: "web",
  },
  "control-plane": {
    imageName: "control-plane",
    catalogKey: "controlPlane",
    workload: "deployment/pi-cloud-control-plane",
    container: "control-plane",
  },
};
export const modelTests = new Set([
  "scripts/lib/control-plane-release.test.mjs",
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
    files.some(ordinaryControlToolSource) &&
    files.every(
      (file) =>
        ordinaryControlToolSource(file) ||
        documentation(file) ||
        operatorSources.has(file) ||
        /(?:^|\/)test\/.*\.test\.[cm]?tsx?$/.test(file) ||
        /^scripts\/lib\/.*\.test\.mjs$/.test(file),
    )
  )
    return { scope: "control-plane", matrix: { include: [fullImages[0]] }, buildImages: true };
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
