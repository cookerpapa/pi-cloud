import type {
  ResourceBackendSelection,
  ResourceBackendResource,
  DevelopmentEnvironmentProfileKey,
} from "@pi-cloud/protocol";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

/** Call while the selected domain row is locked by resource admission. */
export function selectedBackendTemplate(
  domain: { id: string; backend_revision: string; backend_catalog: Record<string, unknown> | null },
  selection?: ResourceBackendSelection,
  profile?: DevelopmentEnvironmentProfileKey,
) {
  const catalog = domain.backend_catalog as unknown as ResourceBackendResource | null;
  const template = selection
    ? catalog?.templates.find((t) => t.id === selection.templateId)
    : catalog?.templates[0];
  if (
    selection &&
    (domain.id !== selection.id ||
      Number(domain.backend_revision) !== selection.revision ||
      !template ||
      (profile && !template.profiles.includes(profile)))
  )
    throw new ControlPlaneStoreError(
      "conflict",
      "Resource backend or template changed; refresh the selection",
    );
  return template;
}
