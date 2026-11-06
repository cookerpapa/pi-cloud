import type { ModelUsageFact, ModelRate, ModelPrice } from "@pi-cloud/protocol";
export function priceModelUsage(
  usage: ModelUsageFact,
  purpose: string,
  rate?: ModelRate,
): ModelPrice {
  if (usage.quality !== "complete" || usage.tokens.total === 0)
    return { state: "unconfirmed", reason: "missing_or_incomplete_usage" };
  if (purpose === "image" || usage.unsupportedDimensions)
    return { state: "unpriced", reason: "unsupported_dimensions" };
  if (!rate) return { state: "unpriced", reason: "missing_rate" };
  if (usage.failed && !rate.includeFailed)
    return { state: "waived", rateId: rate.id, currency: rate.currency, amountPico: "0" };
  let amount = 0n;
  for (const key of ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const) {
    const [whole, fraction = ""] = rate.perMillion[key].split(".");
    const microPerMillion = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
    amount += BigInt(usage.tokens[key]) * microPerMillion;
  }
  // Six decimal places per million tokens => twelve decimal currency places.
  // Retain exact sub-cent amounts; only presentation rounds, never each token.
  return {
    state: "priced",
    rateId: rate.id,
    currency: rate.currency,
    amountPico: amount.toString(),
  };
}
export function formatModelAmount(pico: string): string {
  const n = BigInt(pico);
  return `${n / 1_000_000_000_000n}.${(n % 1_000_000_000_000n).toString().padStart(12, "0")}`;
}
