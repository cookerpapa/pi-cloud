export const catalogSeed = "deploy/helm/pi-cloud-platform/files/model-catalog.json";
export const operatorSources = new Set([
  "scripts/lib/source-delivery-barrier.mjs",
  "scripts/lib/source-delivery-barrier.test.mjs",
  "scripts/lib/source-delivery-observation.mjs",
  "scripts/run-component-release.mjs",
  "scripts/check-helm-self-hosted.mjs",
  "scripts/run-matched-release.mjs",
  "scripts/lib/matched-release.mjs",
  "scripts/lib/cube-node-readiness.mjs",
  "scripts/run-live-model-metering-check.mjs",
  "scripts/run-live-fast-compaction-check.mjs",
  "scripts/run-model-billing-browser-check.mjs",
  "scripts/lib/live-contract.mjs",
  "scripts/lib/live-contract.test.mjs",
  "scripts/run-live-model-runtime-check.mjs",
  "scripts/run-live-control-plane-outage-check.mjs",
  "scripts/run-live-native-input-check.mjs",
  "scripts/run-release-scope-check.mjs",
  "scripts/run-live-component-release-check.mjs",
  "scripts/lib/component-release.mjs",
  "scripts/lib/release-lock.mjs",
  "scripts/lib/model-catalog-probe.mjs",
  "scripts/generate-release-evidence.mjs",
  "scripts/lib/release-image-evidence.mjs",
  "scripts/lib/tool-host-release.mjs",
  "scripts/lib/tool-host-activation.mjs",
  "scripts/lib/owned-runtime-outage.mjs",
  "scripts/lib/runtime-capability-acceptance.mjs",
  "scripts/run-live-tool-host-release-check.mjs",
  "scripts/run-live-development-environment-check.mjs",
  "scripts/run-live-android-check.mjs",
  "scripts/run-live-schedules-check.mjs",
  "scripts/run-history-layout-check.mjs",
  "scripts/run-history-window-check.mjs",
  "scripts/run-live-history-layout-check.mjs",
  "scripts/run-live-same-worker-recovery-check.mjs",
  "scripts/run-live-model-continuation-check.mjs",
  "scripts/lib/model-continuation-traffic.mjs",
  "scripts/run-live-interrupted-text-check.mjs",
  "scripts/configure-provider-websockets.mjs",
  "scripts/lib/provider-websocket-policy.mjs",
  "scripts/lib/owned-acceptance-cleanup.mjs",
  "scripts/run-live-workspace-transfer-check.mjs",
  "scripts/release-impact.mjs",
  "scripts/lib/release-impact.mjs",
]);
export const ordinaryControlToolSource = (file) =>
  /^packages\/control-plane\/src\/ordinary-tools\/.*\.ts$/.test(file);
export const providerConfigurationSources = new Set([
  "scripts/init-production.mjs",
  "scripts/configure-deepseek-native-responses.mjs",
  "scripts/lib/provider-runtime-config.mjs",
  "scripts/lib/provider-runtime-policy.mjs",
  "scripts/lib/provider-config-release.mjs",
]);
export const providerSources = new Set([
  "deploy/provider-gateway/usage_capture_stream.go",
  "deploy/provider-gateway/usage_capture_stream_test.go",
  ".dockerignore",
  "deploy/provider-gateway/Dockerfile",
  "deploy/provider-gateway/model_sessions.go",
  "deploy/provider-gateway/model_sessions_test.go",
  "deploy/provider-gateway/model_sessions.patch",
  "deploy/provider-gateway/image_request_policy.go",
  "deploy/provider-gateway/image_request_policy_test.go",
  "deploy/provider-gateway/image_request_policy.patch",
  "deploy/provider-gateway/config_v8.go",
  "deploy/provider-gateway/config_v8_test.go",
  "deploy/provider-gateway/metering.go",
  "deploy/provider-gateway/metering_journal.go",
  "deploy/provider-gateway/metering_test.go",
  "deploy/provider-gateway/usage_capture.go",
  "deploy/provider-gateway/metering.patch",
  "deploy/helm/pi-cloud-infrastructure/templates/provider.yaml",
  ...providerConfigurationSources,
]);
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
  "tool-host": {
    imageName: "control-plane",
    buildScope: "control-plane",
    buildCatalogKey: "controlPlane",
    catalogKey: "toolHost",
    componentName: "tool-host",
    workload: "deployment/pi-cloud-tool-host",
    container: "tool-host",
  },
};
export const modelTests = new Set([
  "scripts/lib/tool-host-release.test.mjs",
  "scripts/lib/owned-runtime-outage.test.mjs",
  "scripts/lib/component-release.test.mjs",
  "scripts/lib/model-catalog-probe.test.mjs",
  "scripts/lib/release-impact.test.mjs",
  "scripts/lib/release-image-evidence.test.mjs",
  "scripts/lib/matched-release.test.mjs",
  "scripts/lib/cube-node-readiness.test.mjs",
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
    return { scope: "tool-host", matrix: { include: [fullImages[0]] }, buildImages: true };
  if (
    files.some(
      (file) =>
        !documentation(file) &&
        file !== catalogSeed &&
        !providerSources.has(file) &&
        !operatorSources.has(file) &&
        !modelTests.has(file),
    )
  )
    return full();
  const provider = files.some((file) => providerSources.has(file));
  const scope = provider && !files.includes(catalogSeed) ? "provider" : "catalog";
  return { scope, matrix: { include: provider ? [fullImages.at(-1)] : [] }, buildImages: provider };
}
