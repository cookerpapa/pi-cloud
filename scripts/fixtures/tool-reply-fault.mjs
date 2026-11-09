import { readFileSync, writeFileSync } from "node:fs";

/** Acceptance-only adapter wrapper. No production import or runtime fault flag. */
export function wrapCompletionAdapter(Base, configPath, statePath) {
  const accept = Base.prototype.accept;
  return class extends Base {
    async accept(packet) {
      let config;
      try {
        config = JSON.parse(readFileSync(configPath, "utf8"));
      } catch {
        return accept.call(this, packet);
      }
      if (!config.tenantId || !config.marker || !config.nonce || config.expiresAt <= Date.now())
        return accept.call(this, packet);
      let state = { nonce: config.nonce, results: [], probes: [] };
      try {
        const prior = JSON.parse(readFileSync(statePath, "utf8"));
        if (prior.nonce === config.nonce) state = prior;
      } catch {}
      const context = packet.context;
      const result =
        packet.kind === "result" &&
        context?.scope?.tenantId === config.tenantId &&
        context.toolName === "bash" &&
        packet.result?.output?.response?.event?.result?.content?.some(
          (part) => part.type === "text" && part.text.includes(config.marker),
        );
      const probe =
        packet.kind === "result" &&
        context?.kind === "execution_probe" &&
        context.bindingIds.some((id) => state.results.some((r) => r.bindingId === id));
      if (!result && !probe) return accept.call(this, packet);
      const entry = { operationId: packet.operationId, at: Date.now() };
      if (result)
        state.results.push({
          ...entry,
          runId: context.scope.runId,
          bindingId: context.execution?.bindingId,
        });
      else state.probes.push({ ...entry, suppressed: !!config.dropProbe });
      state.results = state.results.slice(-32);
      state.probes = state.probes.slice(-32);
      // Only bounded fixture identities/timing, never Tool bodies or credentials.
      writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
      if (result && config.dropAck) {
        await accept.call(this, packet);
        if (state.results.filter((row) => row.operationId === packet.operationId).length === 1)
          throw new Error("Owned acceptance: callback ACK lost after Kafka commit");
        return;
      }
      if (probe && !config.dropProbe) return accept.call(this, packet);
      // main.ts will ACK delivery, deliberately emulating loss before Kafka publication.
    }
  };
}
