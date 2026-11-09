/** Public delivery coordinates and an opaque, operation-scoped capability.
 * No Kafka/PG/object-store address or long-lived key belongs in a Guest. */
export type ToolCompletionDestination = Readonly<{
  url: string;
  address: string;
  ca: string;
  capability: string;
  expiresAt: number;
}>;
export function parseToolCompletionDestination(value: unknown): ToolCompletionDestination {
  const v = value as ToolCompletionDestination | undefined;
  if (
    !v ||
    typeof v.url !== "string" ||
    v.url.length > 2048 ||
    typeof v.address !== "string" ||
    !/^[0-9a-fA-F:.]{3,64}$/.test(v.address) ||
    typeof v.ca !== "string" ||
    v.ca.length > 16384 ||
    !v.ca.includes("-----BEGIN CERTIFICATE-----") ||
    typeof v.capability !== "string" ||
    v.capability.length > 8192 ||
    !Number.isSafeInteger(v.expiresAt) ||
    v.expiresAt < 1
  )
    throw new Error("Invalid Tool completion destination");
  const url = new URL(v.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== "/v1/completions"
  )
    throw new Error("Invalid Tool completion endpoint");
  return v;
}
