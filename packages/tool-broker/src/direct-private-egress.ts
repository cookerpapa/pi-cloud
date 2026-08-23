function ipv4Integer(octets: readonly number[]): number {
  return (octets[0]! * 2 ** 24 + octets[1]! * 2 ** 16 + octets[2]! * 2 ** 8 + octets[3]!) >>> 0;
}

function ipv4Text(value: number): string {
  return [24, 16, 8, 0].map((shift) => String((value >>> shift) & 0xff)).join(".");
}

function normalizePrivateCidr(value: string): string {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/u.exec(value.trim());
  if (match === null) throw new TypeError("CubeSandbox direct private CIDR is invalid");
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (
    prefix < 1 ||
    prefix > 32 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    throw new TypeError("CubeSandbox direct private CIDR is invalid");
  }
  const address = ipv4Integer(octets);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (address & mask) >>> 0;
  const first = network >>> 24;
  const second = (network >>> 16) & 0xff;
  const privateRange =
    (prefix >= 8 && first === 10) ||
    (prefix >= 12 && first === 172 && second >= 16 && second <= 31) ||
    (prefix >= 16 && first === 192 && second === 168);
  if (!privateRange) {
    throw new TypeError("CubeSandbox direct egress must be an RFC1918 CIDR");
  }
  return `${ipv4Text(network)}/${String(prefix)}`;
}

export function directPrivateEgressCidrs(
  input: string | readonly string[] | undefined,
): readonly string[] {
  const values =
    input === undefined || input === ""
      ? []
      : typeof input === "string"
        ? input.split(",")
        : [...input];
  if (values.length > 32) throw new TypeError("Too many CubeSandbox direct private CIDRs");
  return Object.freeze([...new Set(values.map(normalizePrivateCidr))]);
}
