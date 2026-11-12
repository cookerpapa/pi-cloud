export const catalogSeed = "deploy/helm/pi-cloud-platform/files/model-catalog.json";
export const operatorSources = new Set([
  "scripts/prefetch-cubesandbox-images.mjs",
  "scripts/lib/cube-upstream-images.mjs",
  "scripts/lib/cube-upgrade-plan.mjs",
  "scripts/run-live-resource-backend-check.mjs",
  "scripts/lib/registered-backend-fixture.mjs",
  "scripts/lib/runtime-file-policy.mjs",
  "scripts/lib/boxlite-backend-maintenance.mjs",
  "scripts/lib/metadata-release.mjs",
  "scripts/lib/retire-workspace-registrations.mjs",
  "scripts/lib/adopt-workspace-persistence.mjs",
  "scripts/lib/native-volume-attachment-state.mjs",
  "scripts/lib/native-volume-attachment-state.test.mjs",
  "scripts/run-workspace-storage-pool.mjs",
  "scripts/lib/workspace-storage-pool.mjs",
  "scripts/lib/workspace-storage-pool-guard.mjs",
  "scripts/lib/release-plan.mjs",
  "scripts/run-boxlite-release.mjs",
  "scripts/run-boxlite-node-live-check.mjs",
  "scripts/run-live-boxlite-lifecycle-check.mjs",
  "scripts/run-android-release.mjs",
  "scripts/retire-obsolete-cube-metadata.mjs",
  "scripts/lib/obsolete-cube-metadata.mjs",
  "scripts/lib/obsolete-cube-metadata.test.mjs",
  "scripts/lib/matched-workspace-storage.mjs",
  "scripts/lib/matched-workspace-storage.test.mjs",
  "scripts/cube-metadata-cleanup/go.mod",
  "scripts/cube-metadata-cleanup/go.sum",
  "scripts/cube-metadata-cleanup/main.go",
  "scripts/cube-metadata-cleanup/main_test.go",
  "eval/fault-cases.json",
  "scripts/lib/live-tool-reply-fault.mjs",
  "scripts/fixtures/tool-reply-fault.mjs",
  "scripts/run-live-tool-reply-continuation.mjs",
  "scripts/run-live-execution-probe-check.mjs",
  "scripts/run-live-image-attachment-check.mjs",
  "scripts/run-live-release-acceptance.mjs",
  "scripts/lib/elastic-retention-acceptance.mjs",
  "scripts/run-live-resource-accounting-check.mjs",
  "scripts/lib/source-delivery-barrier.mjs",
  "scripts/lib/source-delivery-barrier.test.mjs",
  "scripts/lib/source-delivery-observation.mjs",
  "scripts/run-component-release.mjs",
  "scripts/check-helm-self-hosted.mjs",
  "scripts/check-helm-platform.mjs",
  "scripts/run-matched-release.mjs",
  "scripts/lib/matched-release.mjs",
  "scripts/production-kubernetes.mjs",
  "scripts/lib/cube-workspace-contract.mjs",
  "scripts/lib/cube-workspace-contract.test.mjs",
  "scripts/lib/wsl-web-forwarder.mjs",
  "scripts/lib/wsl-web-forwarder.test.mjs",
  "scripts/lib/cube-node-readiness.mjs",
  "scripts/run-live-model-metering-check.mjs",
  "scripts/run-live-fast-compaction-check.mjs",
  "scripts/run-model-billing-browser-check.mjs",
  "scripts/lib/live-contract.mjs",
  "scripts/lib/live-contract.test.mjs",
  "scripts/run-live-model-runtime-check.mjs",
  "scripts/run-live-control-plane-outage-check.mjs",
  "scripts/run-live-native-input-check.mjs",
  "scripts/run-live-user-upload-check.mjs",
  "scripts/run-release-scope-check.mjs",
  "scripts/run-live-component-release-check.mjs",
  "scripts/lib/component-release.mjs",
  "scripts/lib/release-lock.mjs",
  "scripts/lib/model-catalog-probe.mjs",
  "scripts/generate-release-evidence.mjs",
  "scripts/lib/release-image-evidence.mjs",
  "scripts/lib/runtime-component-release.mjs",
  "scripts/lib/tool-host-activation.mjs",
  "scripts/lib/owned-runtime-outage.mjs",
  "scripts/lib/runtime-capability-acceptance.mjs",
  "scripts/run-live-tool-host-release-check.mjs",
  "scripts/run-live-development-environment-check.mjs",
  "scripts/run-live-android-check.mjs",
  "scripts/run-live-android-restart-check.mjs",
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
export const workerBootstrapSource = "packages/supervisor-host/src/model-gateway.ts";
export const sessionRetentionSource = "packages/sandbox-control/src/session-activity-retention.ts";
export const sessionDecoderSource = "packages/runtime-core/src/session-log-envelope.ts";
export const sessionApiSource = (file) =>
  /^packages\/control-plane\/src\/(?:session-api-main|application|control-plane\.module|control-plane\.controller|workspace-capacity-controller|resource-billing-controller|model-billing-controller|workspace-file-transfer-controller|skill-market-controller)\.ts$/.test(
    file,
  ) || /^packages\/control-plane\/src\/public-api\/.*\.ts$/.test(file);
export const imageReleaseTargets = {
  "worker-bootstrap": {
    imageName: "supervisor-host",
    buildScope: "worker",
    catalogKey: "worker",
    componentName: "supervisor-host",
    workload: "statefulset/pi-cloud-pi-worker-primary-v1",
    container: "pi-worker",
  },
  "session-retention": {
    imageName: "control-plane",
    buildScope: "control-plane",
    buildCatalogKey: "controlPlane",
    catalogKey: "sessionRuntime",
    componentName: "session-runtime",
    workload: "deployment/pi-cloud-session-runtime",
    container: "session-runtime",
  },
  "session-api": {
    imageName: "control-plane",
    buildScope: "control-plane",
    buildCatalogKey: "controlPlane",
    catalogKey: "sessionApi",
    componentName: "session-api",
    workload: "deployment/pi-cloud-session-api",
    container: "session-api",
  },
  "session-decoder": {
    imageName: "control-plane",
    buildScope: "control-plane",
    buildCatalogKey: "controlPlane",
    catalogKey: "sessionRuntime",
    componentName: "session-runtime",
    workload: "deployment/pi-cloud-session-runtime",
    container: "session-runtime",
  },
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
  "scripts/lib/cube-upstream-images.test.mjs",
  "scripts/lib/image-import-cli.test.mjs",
  "scripts/lib/cube-upgrade-plan.test.mjs",
  "scripts/lib/release-plan.test.mjs",
  "scripts/lib/runtime-component-release.test.mjs",
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
/** One reviewed allowlist shared by CI classification and manual preflight. */
export function permitsScopedSource(scope, file, runtimeInputs) {
  return (
    operatorSources.has(file) ||
    // BoxLite node code is independently published and is absent from the
    // ordinary role images. Require the selected Docker input closure to
    // prove that absence; never excuse shared provider/protocol changes.
    (runtimeInputs instanceof Set &&
      file.startsWith("packages/boxlite-node/src/") &&
      !runtimeInputs.has(file)) ||
    (scope === "tool-host" && ordinaryControlToolSource(file)) ||
    (scope === "tool-host" &&
      file === "deploy/helm/pi-cloud-platform/templates/network-policy.yaml") ||
    (scope === "session-decoder" && file === sessionDecoderSource) ||
    (scope === "session-retention" && file === sessionRetentionSource) ||
    (scope === "worker-bootstrap" &&
      (file === workerBootstrapSource || file === "scripts/production-kubernetes.mjs")) ||
    (scope === "session-api" && sessionApiSource(file)) ||
    (scope === "web" &&
      (file === "packages/web-ui/index.html" ||
        /^packages\/web-ui\/src\/.*\.(tsx|css)$/.test(file) ||
        [
          "session-view.ts",
          "conversation-presentation.ts",
          "virtual-conversation-rows.ts",
          "composer-submission.ts",
          "submission-presentation.ts",
        ].some((name) => file === `packages/web-ui/src/${name}`) ||
        [
          "scripts/production-kubernetes.mjs",
          "scripts/run-browser-presentation-check.mjs",
          "scripts/run-browser-queue-check.mjs",
          "scripts/run-skill-market-browser-check.mjs",
          "scripts/run-live-skill-market-browser-check.mjs",
          "scripts/run-live-browser-ui-check.mjs",
          "scripts/run-live-queue-input-check.mjs",
          "scripts/run-live-release-acceptance.mjs",
          "scripts/run-live-review-repair-check.mjs",
          "scripts/run-live-development-environment-check.mjs",
          "scripts/run-live-missing-directory-check.mjs",
        ].includes(file))) ||
    (["provider", "catalog"].includes(scope) &&
      (file === catalogSeed || file === "deploy/provider-gateway/Dockerfile")) ||
    (scope === "provider" && providerSources.has(file)) ||
    file === "README.md" ||
    file === "AGENTS.md" ||
    file.startsWith("docs/") ||
    /(?:^|\/)test\/.*\.test\.[cm]?tsx?$/.test(file) ||
    /^scripts\/lib\/.*\.test\.mjs$/.test(file)
  );
}

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
const documentation = (file) =>
  file === "README.md" || file === "AGENTS.md" || file.startsWith("docs/");
export function releaseImpact(files) {
  const full = () => ({ scope: "full", matrix: { include: fullImages }, buildImages: true });
  if (!files?.length) return full();
  if (files.every(documentation))
    return { scope: "docs", matrix: { include: [] }, buildImages: false };
  const sources = {
    "session-api": sessionApiSource,
    "tool-host": ordinaryControlToolSource,
    "worker-bootstrap": (file) => file === workerBootstrapSource,
    "session-retention": (file) => file === sessionRetentionSource,
    "session-decoder": (file) => file === sessionDecoderSource,
    web: (file) => file.startsWith("packages/web-ui/src/") || file === "packages/web-ui/index.html",
  };
  for (const [scope, source] of Object.entries(sources)) {
    if (!files.some(source) || !files.every((file) => permitsScopedSource(scope, file))) continue;
    const target = imageReleaseTargets[scope];
    return {
      scope,
      matrix: { include: fullImages.filter((image) => image.image === target.imageName) },
      buildImages: true,
    };
  }
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
