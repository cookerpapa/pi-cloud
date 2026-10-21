import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseModelCatalogConfiguration } from "@pi-cloud/protocol";
export const fixtureModelCatalog = parseModelCatalogConfiguration(
  JSON.parse(
    readFileSync(
      new URL("../../deploy/helm/pi-cloud-platform/files/model-catalog.json", import.meta.url),
      "utf8",
    ),
  ),
);
export const fixtureCatalogRevision = createHash("sha256")
  .update(JSON.stringify(fixtureModelCatalog))
  .digest("hex");
export function fixtureModelRuntime(provider, modelId) {
  const model = fixtureModelCatalog.models.find(
    (m) => m.provider === provider && m.modelId === modelId,
  );
  if (!model) return null;
  const {
    provider: _provider,
    modelId: _id,
    displayName: _name,
    visible: _visible,
    ...runtime
  } = model;
  return structuredClone({ catalogRevision: fixtureCatalogRevision, ...runtime });
}
