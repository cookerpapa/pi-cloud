import type { ModelCatalogConfiguration, ModelRuntimeSnapshot } from "@pi-cloud/protocol";
export const fixtureModelCatalog: ModelCatalogConfiguration;
export const fixtureCatalogRevision: string;
export function fixtureModelRuntime(provider: string, modelId: string): ModelRuntimeSnapshot | null;
