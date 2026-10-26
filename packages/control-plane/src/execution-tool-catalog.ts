import { androidToolDefinitions, type ControlToolCatalogSource } from "@pi-cloud/protocol";
import { controlToolCatalog } from "./control-tool-registry.ts";

/** Definitions follow code-owned executors. The Worker filters each Conversation
 * by its accepted grants; publishing a definition does not grant a phone. */
export function executionToolCatalog(ordinary: ControlToolCatalogSource): ControlToolCatalogSource {
  let revision: string | undefined;
  let snapshot = controlToolCatalog([]);
  return {
    read() {
      const value = ordinary.read();
      if (value.revision !== revision) {
        snapshot = controlToolCatalog([...value.tools, ...androidToolDefinitions()]);
        revision = value.revision;
      }
      return snapshot;
    },
    subscribe: (listener) => ordinary.subscribe(listener),
  };
}
