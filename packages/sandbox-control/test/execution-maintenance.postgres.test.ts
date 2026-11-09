import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { toolReplyTopic } from "@pi-cloud/event-log";
import type { PathProbe } from "@pi-cloud/protocol";
import { nativeSubagentFixture } from "../../control-plane/test/native-subagent-fixture.ts";
import { ExecutionMaintenance } from "../src/execution-maintenance.ts";
import type { SandboxBindingView } from "../src/sandbox-binding-view.ts";
import type { RuntimeRetention } from "../src/runtime-retention.ts";
import type { ExecutionPathProbes } from "../src/execution-path-probes.ts";

it("uses the actual Worker boot and host address schema for a recovered family's readiness", async () => {
  const f = await nativeSubagentFixture();
  const consume = vi.fn();
  let maintenance: ExecutionMaintenance | undefined;
  try {
    const worker = await f.database.selectFrom("workers").selectAll().executeTakeFirstOrThrow();
    await f.database
      .insertInto("supervisor_hosts")
      .values({
        supervisor_id: worker.supervisor_id,
        maximum_capacity: 1,
        management_base_url: "http://127.0.0.1:4100/",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    maintenance = new ExecutionMaintenance({
      database: f.database,
      bindings: {
        owner: () => () => true,
        writerBindings: () => [],
      } as unknown as SandboxBindingView,
      retention: { retain: () => {} } as unknown as RuntimeRetention,
      probes: { consume } as unknown as ExecutionPathProbes,
      managementToken: "fixture-management",
    });
    const fact: PathProbe = {
      kind: "path_probe",
      factId: randomUUID(),
      scope: f.scope,
      occurredAt: new Date().toISOString(),
      execution: { replyTopic: toolReplyTopic(worker.boot_id), bindings: [] },
    };
    await maintenance.tick(); // Real SQL must also compile for the periodic bucket path.
    expect(await maintenance.request(fact)).toBe(true);
    expect(consume).toHaveBeenCalledOnce();
    expect(
      await maintenance.request({
        ...fact,
        execution: { ...fact.execution!, replyTopic: toolReplyTopic(randomUUID()) },
      }),
    ).toBe(false);
    expect(await maintenance.request({ ...fact, scope: { ...fact.scope, fencingToken: 2 } })).toBe(
      false,
    );
    await f.database
      .updateTable("session_leases")
      .set({ tool_bindings_closed_at: new Date() })
      .where("lease_id", "=", f.scope.writerId)
      .execute();
    expect(await maintenance.request(fact)).toBe(false);
    expect(consume).toHaveBeenCalledOnce();
  } finally {
    await maintenance?.close();
    await f.close();
  }
}, 30_000);
