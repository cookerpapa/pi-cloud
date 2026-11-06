import type {
  ResourceMeteringEvent,
  ResourceRate,
  ResourcePrice,
  ResourceValuation,
} from "@pi-cloud/protocol";

function micro(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function priceResourceInterval(
  event: ResourceMeteringEvent,
  durationMs: number,
  rate?: ResourceRate,
): ResourcePrice {
  if (event.quality !== "confirmed") return { state: "unconfirmed", reason: event.reason! };
  if (!rate || rate.resourceKind !== event.quantity.kind)
    return { state: "unpriced", reason: "missing_rate" };
  const duration = BigInt(durationMs);
  // One common denominator, one final division per interval. Keep binary
  // floating point out of monetary arithmetic. Resolution is 10^-12 currency.
  const gib = 1_073_741_824n;
  let numerator: bigint, denominator: bigint;
  if (event.quantity.kind === "compute" && rate.resourceKind === "compute") {
    numerator =
      (micro(rate.perHour.cpuCore) * BigInt(event.quantity.cpuMillis) * gib +
        micro(rate.perHour.memoryGiB) * BigInt(event.quantity.memoryBytes) * 1000n) *
      duration *
      1_000_000n;
    denominator = 3_600_000n * 1000n * gib;
  } else if (event.quantity.kind === "workspace" && rate.resourceKind === "workspace") {
    numerator =
      micro(rate.perHour.capacityGiB) *
      BigInt(event.quantity.capacityBytes) *
      duration *
      1_000_000n;
    denominator = 3_600_000n * gib;
  } else throw new TypeError("Resource tariff dimension mismatch");
  return {
    state: "priced",
    rateId: rate.id,
    currency: rate.currency,
    amountPico: (numerator / denominator).toString(),
  };
}

export function valueResourceReceipt(
  event: ResourceMeteringEvent,
  rates: ResourceRate[],
): ResourceValuation[] {
  const start = Date.parse(event.from),
    end = Date.parse(event.to);
  const boundaries = [
    ...new Set([
      start,
      end,
      ...rates.map((r) => Date.parse(r.effectiveAt)).filter((t) => t > start && t < end),
    ]),
  ].sort((a, b) => a - b);
  if (boundaries.length === 1) boundaries.push(end);
  return boundaries.slice(0, -1).map((from, index) => {
    const to = boundaries[index + 1]!;
    const select = (kind: ResourceRate["kind"]) =>
      rates
        .filter((r) => r.kind === kind && Date.parse(r.effectiveAt) <= from)
        .sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt))[0];
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      customer: priceResourceInterval(event, to - from, select("customer")),
      upstream_estimate: priceResourceInterval(event, to - from, select("upstream_estimate")),
    };
  });
}
