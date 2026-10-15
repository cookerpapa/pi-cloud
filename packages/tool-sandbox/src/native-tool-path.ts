import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

// Pi 1.0's helper is private. Keep this small interpretation boundary checked
// against the public native Tools, while retaining bounded/image-capable Read.
export function normalizeToolPath(path: string): string {
  const normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}

export async function resolveReadToolPath(
  env: Pick<NodeExecutionEnv, "absolutePath" | "exists">,
  path: string,
  context: typeof BACKGROUND_CONTEXT,
): Promise<string> {
  const resolved = getOrThrow(await env.absolutePath(normalizeToolPath(path), context));
  const variants = [
    resolved,
    resolved.replace(/ (AM|PM)\./gi, "\u202F$1."),
    resolved.normalize("NFD"),
    resolved.replace(/'/g, "\u2019"),
    resolved.normalize("NFD").replace(/'/g, "\u2019"),
  ];
  for (const variant of new Set(variants))
    if (getOrThrow(await env.exists(variant, context))) return variant;
  return resolved;
}
