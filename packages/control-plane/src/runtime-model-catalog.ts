import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseModelCatalogConfiguration,
  type CatalogModel,
  type ModelCatalogConfiguration,
  type ModelRuntimeSnapshot,
} from "@pi-cloud/protocol";

export type LoadedModelCatalog = Readonly<{
  revision: string;
  configuration: ModelCatalogConfiguration;
}>;

function load(path: string): LoadedModelCatalog {
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new TypeError("Model catalog could not be read as JSON");
  }
  const configuration = parseModelCatalogConfiguration(decoded);
  const revision = createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
  for (const model of configuration.models) {
    Object.freeze(model.thinkingLevels);
    Object.freeze(model.inputModalities);
    Object.freeze(model.hostedTools);
    Object.freeze(model);
  }
  Object.freeze(configuration.models);
  Object.freeze(configuration.defaultModel);
  Object.freeze(configuration);
  return Object.freeze({ revision, configuration });
}

/** File projection is disposable; accepted Run snapshots remain in PostgreSQL. */
export class RuntimeModelCatalog {
  #current: LoadedModelCatalog;
  #nextRead = 0;
  #reloadFailed = false;
  constructor(
    readonly path: string,
    readonly intervalMs = 1000,
    readonly now = Date.now,
  ) {
    this.#current = load(path);
    this.#nextRead = now() + intervalMs;
  }
  read(): LoadedModelCatalog {
    const now = this.now();
    if (now >= this.#nextRead) {
      this.#nextRead = now + this.intervalMs;
      try {
        this.#current = load(this.path);
        this.#reloadFailed = false;
      } catch {
        this.#reloadFailed = true;
      }
    }
    return this.#current;
  }
  status(): { revision: string; reloadFailed: boolean } {
    return { revision: this.read().revision, reloadFailed: this.#reloadFailed };
  }
}
let processCatalog: RuntimeModelCatalog | undefined;
export function runtimeModelCatalog(): RuntimeModelCatalog {
  return (processCatalog ??= new RuntimeModelCatalog(
    process.env.PI_CLOUD_MODEL_CATALOG_FILE ??
      fileURLToPath(
        new URL("../../../deploy/helm/pi-cloud-platform/files/model-catalog.json", import.meta.url),
      ),
  ));
}
export function currentModelCatalog(): LoadedModelCatalog {
  return runtimeModelCatalog().read();
}
export function catalogModel(
  provider: string,
  modelId: string,
  catalog = currentModelCatalog(),
): CatalogModel | undefined {
  return catalog.configuration.models.find((m) => m.provider === provider && m.modelId === modelId);
}
export function freezeModelRuntime(
  model: CatalogModel,
  catalog: LoadedModelCatalog,
): ModelRuntimeSnapshot {
  const {
    provider: _provider,
    modelId: _modelId,
    displayName: _displayName,
    visible: _visible,
    ...runtime
  } = model;
  return structuredClone({ catalogRevision: catalog.revision, ...runtime });
}
