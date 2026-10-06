export const PI_CLOUD_CUBE_TEMPLATE_IMAGE_PREFIX =
  "pi-cloud-cube-template-registry.cube-system.svc.cluster.local:5000/pi-cloud/cubesandbox-tool@";

const terminalStatuses = new Set(["FAILED", "ERROR", "CANCELLED"]);

export function parseCubeTemplateRetention(value) {
  const retention = Number(value ?? 3);
  if (!Number.isSafeInteger(retention) || retention < 2 || retention > 10) {
    throw new Error("Cube template retention must be an integer from 2 through 10");
  }
  return retention;
}

function piCloudTemplate(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    /^tpl-[a-z0-9]{24}$/.test(value.template_id ?? "") &&
    typeof value.image_info === "string" &&
    value.image_info.startsWith(PI_CLOUD_CUBE_TEMPLATE_IMAGE_PREFIX)
  );
}

function newestFirst(left, right) {
  const leftTime = Date.parse(left.created_at ?? "");
  const rightTime = Date.parse(right.created_at ?? "");
  const normalizedLeft = Number.isFinite(leftTime) ? leftTime : 0;
  const normalizedRight = Number.isFinite(rightTime) ? rightTime : 0;
  return normalizedRight - normalizedLeft || left.template_id.localeCompare(right.template_id);
}

export function selectCubeTemplatesForDeletion({
  inventory,
  protectedTemplateIds = [],
  retention,
}) {
  if (!Array.isArray(inventory)) {
    throw new Error("Cube template inventory must be an array");
  }
  const limit = parseCubeTemplateRetention(retention);
  const owned = inventory.filter(piCloudTemplate);
  const protectedIds = new Set(
    protectedTemplateIds.filter((value) => /^tpl-[a-z0-9]{24}$/.test(value ?? "")),
  );
  const keep = new Set(protectedIds);
  for (const template of owned.filter((value) => value.status === "READY").sort(newestFirst)) {
    if (keep.size >= limit) break;
    keep.add(template.template_id);
  }

  return owned
    .filter(
      (template) =>
        !keep.has(template.template_id) &&
        (template.status === "READY" || terminalStatuses.has(template.status)),
    )
    .sort((left, right) => -newestFirst(left, right));
}

/** One auxiliary cleanup budget for the whole release, shared across phases.
 * A failed/uncertain delete leaves Cube's recorded target intact. Stop issuing
 * more deletes after failure; registration must not queue a timeout per replica.
 */
export function createCubeTemplatePruner({
  deleteTemplate,
  now = () => performance.now(),
  budgetMs = 30_000,
}) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1)
    throw new Error("Template cleanup budget must be a positive integer");
  let remainingMs = budgetMs;
  let stopReason;
  return async (selected) => {
    let deleted = 0;
    let failure;
    for (const template of selected) {
      if (stopReason || remainingMs <= 0) break;
      const started = now();
      try {
        await deleteTemplate(template.template_id, Math.max(1, Math.ceil(remainingMs)));
        deleted += 1;
      } catch (error) {
        stopReason = "delete_unconfirmed";
        failure = { templateId: template.template_id, error };
      } finally {
        remainingMs = Math.max(0, remainingMs - Math.max(0, now() - started));
        if (remainingMs === 0) stopReason ??= "budget_exhausted";
      }
    }
    return { deleted, deferred: selected.length - deleted, stopReason, failure };
  };
}
