import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { wrapCompletionAdapter } from "../fixtures/tool-reply-fault.mjs";

it("isolates reply loss to the armed tenant/result and its guest probe, with expiry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reply-fault-test-"));
  const config = join(directory, "config"),
    state = join(directory, "state"),
    accepted = vi.fn();
  class Base {
    async accept(packet) {
      accepted(packet);
    }
  }
  const Adapter = wrapCompletionAdapter(Base, config, state),
    adapter = new Adapter();
  const packet = {
    kind: "result",
    operationId: "operation",
    context: {
      scope: { tenantId: "owned", runId: "run" },
      toolName: "bash",
      execution: { bindingId: "binding" },
    },
    result: {
      output: {
        response: { event: { result: { content: [{ type: "text", text: "PRIVATE marker" }] } } },
      },
    },
  };
  const settings = {
    tenantId: "owned",
    marker: "marker",
    nonce: "first",
    expiresAt: Date.now() + 10000,
    dropProbe: true,
  };
  try {
    await writeFile(config, JSON.stringify(settings));
    await adapter.accept(packet);
    expect(accepted).not.toHaveBeenCalled();
    const probe = {
      kind: "result",
      operationId: "probe",
      context: { kind: "execution_probe", bindingIds: ["binding"] },
    };
    await adapter.accept(probe);
    const metadata = await readFile(state, "utf8");
    expect(metadata).not.toContain("PRIVATE");
    expect(JSON.parse(metadata)).toMatchObject({
      results: [{ operationId: "operation" }],
      probes: [{ operationId: "probe" }],
    });
    await adapter.accept({
      ...packet,
      context: { ...packet.context, scope: { tenantId: "unrelated" } },
    });
    await adapter.accept({ ...probe, context: { ...probe.context, bindingIds: ["unrelated"] } });
    expect(accepted).toHaveBeenCalledTimes(2);
    await writeFile(config, JSON.stringify({ ...settings, dropProbe: false }));
    await adapter.accept(probe);
    expect(accepted).toHaveBeenCalledTimes(3);
    await writeFile(config, JSON.stringify({ ...settings, expiresAt: 1 }));
    await adapter.accept(packet);
    expect(accepted).toHaveBeenCalledTimes(4);
  } finally {
    await rm(directory, { recursive: true });
  }
});
