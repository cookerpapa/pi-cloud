import { ToolCompletionCapabilities } from "@pi-cloud/protocol/completion-capability";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type ToolCompletionGrant, type ToolCompletionDestination } from "@pi-cloud/protocol";

export class ToolCompletionIssuer {
  readonly #authority: ToolCompletionCapabilities;
  #address: { value: string; until: number } | undefined;
  constructor(readonly options: { url: string; ca: string; secret: string }) {
    this.#authority = new ToolCompletionCapabilities(options.secret);
    if (new URL(options.url).protocol !== "https:")
      throw new Error("Tool completion requires HTTPS");
  }
  async issue(grant: ToolCompletionGrant): Promise<ToolCompletionDestination> {
    if (grant.expiresAt <= Date.now())
      throw new Error("Original Tool delivery deadline elapsed before dispatch");
    const url = new URL(this.options.url);
    if (!this.#address || this.#address.until < Date.now())
      this.#address = {
        value: isIP(url.hostname)
          ? url.hostname
          : (await lookup(url.hostname, { family: 4 })).address,
        until: Date.now() + 60_000,
      };
    return {
      url: url.toString(),
      address: this.#address.value,
      ca: this.options.ca,
      capability: this.#authority.issue(grant),
      expiresAt: grant.expiresAt,
    };
  }
}
