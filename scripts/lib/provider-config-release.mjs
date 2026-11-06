import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { applyProviderRuntimePolicy } from "./provider-runtime-policy.mjs";
import { providerManagementAsset } from "./provider-runtime-config.mjs";

export const providerConfigDigest = (body) => createHash("sha256").update(body).digest("hex");

/** normalize runs the fixed candidate's own parser, never a second YAML migration. */
export async function prepareProviderConfiguration(source, normalize) {
  const converted = await normalize(source);
  const document = parseDocument(applyProviderRuntimePolicy(converted));
  assert.equal(document.errors.length, 0, "Provider configuration conversion failed");
  // These assets have always been deployment-owned and pinned by the installer.
  document.setIn(["management", "panel-github-repository"], providerManagementAsset.repository);
  document.setIn(["management", "disable-auto-update-panel"], true);
  const body = await normalize(document.toString());
  assert.equal(applyProviderRuntimePolicy(body), body, "Candidate changed provider policy");
  return {
    body,
    plan: {
      version: 1,
      sourceDigest: providerConfigDigest(source),
      desiredDigest: providerConfigDigest(body),
      managementAssetDigest: providerManagementAsset.sha256,
    },
  };
}

export function assertProviderConfigurationPlan(plan, body, current) {
  assert.equal(plan.version, 1, "Unsupported provider configuration publication");
  assert.equal(
    providerConfigDigest(body),
    plan.desiredDigest,
    "Prepared provider configuration changed",
  );
  assert.equal(
    plan.managementAssetDigest,
    providerManagementAsset.sha256,
    "Provider management asset changed",
  );
  assert(
    [plan.sourceDigest, plan.desiredDigest].includes(providerConfigDigest(current)),
    "Provider configuration changed after preparation",
  );
}

/** Called only after the new provider image is ready. Lost PUT replies are read back. */
export async function applyProviderConfiguration({
  baseUrl,
  managementKey,
  plan,
  body,
  fetchImplementation = fetch,
}) {
  assert.equal(
    providerConfigDigest(body),
    plan.desiredDigest,
    "Prepared provider configuration changed",
  );
  assert.equal(plan.version, 1, "Unsupported provider configuration publication");
  const endpoint = new URL("/v8/management/config.yaml", baseUrl);
  for (let attempt = 0; attempt < 3; attempt++) {
    let current;
    try {
      current = await fetchImplementation(endpoint, {
        headers: { authorization: `Bearer ${managementKey}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      if (attempt === 2)
        throw new Error("Provider configuration is unavailable; resume this candidate");
      continue;
    }
    assert(current.ok, `Provider v8 configuration read failed (HTTP ${current.status})`);
    const etag = current.headers.get("etag");
    await current.body?.cancel();
    if (etag === `"${plan.desiredDigest}"`) return { adopted: true, version: 8 };
    assert.equal(
      etag,
      `"${plan.sourceDigest}"`,
      "Provider configuration changed after preparation",
    );
    try {
      const response = await fetchImplementation(endpoint, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${managementKey}`,
          "content-type": "application/yaml",
          "if-match": etag,
        },
        body,
        signal: AbortSignal.timeout(15000),
      });
      await response.body?.cancel();
      assert(
        response.ok || response.status === 412,
        `Provider v8 configuration adoption failed (HTTP ${response.status})`,
      );
    } catch (error) {
      if (error?.code === "ERR_ASSERTION") throw error;
      // The write may have committed; the next GET decides rather than guessing.
    }
  }
  throw new Error("Provider configuration adoption is unconfirmed; resume this candidate");
}
