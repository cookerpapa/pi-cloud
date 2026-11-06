export function billingAmount(pico: string): string {
  const n = BigInt(pico),
    fraction = (n % 1_000_000_000_000n).toString().padStart(12, "0").replace(/0+$/, "");
  return `${n / 1_000_000_000_000n}${fraction ? `.${fraction}` : ""}`;
}
