import { section } from "@earendil-works/pi-durable";
import type { GuestPublicEgress } from "@pi-cloud/protocol";

export function publicEgressSection(current: () => GuestPublicEgress) {
  return section("cloud-network", () => {
    const status = current().status;
    const policy =
      status === "disabled"
        ? "Public HTTP/HTTPS access from the tool sandbox is disabled by the platform. Public package downloads will fail until this setting changes."
        : status === "enabled"
          ? "Public HTTP/HTTPS access from the tool sandbox is enabled through its configured proxy. This setting does not guarantee upstream connectivity."
          : "The tool sandbox's public-network policy has not been confirmed. Do not assume public package downloads are available.";
    return `${policy} Check existing dependencies before installing new ones. After a network failure, avoid repeating equivalent attempts without new evidence. Verify browser availability before claiming UI interaction tests; report unavailable validation rather than building substitute test infrastructure without a concrete task need.`;
  });
}
