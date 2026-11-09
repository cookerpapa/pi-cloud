import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  EXECUTION_PROBE_RECEIVER_PATH,
  EXECUTION_PROBE_TIMEOUT_MS,
  type PathProbe,
  type RuntimeObservationScope,
} from "@pi-cloud/protocol";
import { toolReplyTopic } from "@pi-cloud/event-log";
import { operationalLog } from "@pi-cloud/observability";
import type { RuntimeRetention } from "./runtime-retention.ts";
import type { ExecutionPathProbes } from "./execution-path-probes.ts";
import type { SandboxBindingView } from "./sandbox-binding-view.ts";

type Family = {
  tenant_id: string;
  pi_session_id: string;
  run_id: string;
  session_id: string;
  turn_id: string;
  writer_id: string;
  fencing_token: string;
  remaining_ms: number;
  boot_id: string;
  management_base_url: string;
  resources: Array<{ id: string; capsule: string }>;
};

/** A batched, disposable maintenance view. PG remains the lease authority;
 * Cubelet remains the finite-expiry authority. No per-Tool SQL or new history. */
export class ExecutionMaintenance {
  #timer: NodeJS.Timeout | undefined;
  #tick: Promise<void> | undefined;
  #closed = false;
  readonly #probes = new Set<Promise<unknown>>();
  readonly #lastProbed = new Map<string, number>();
  readonly #bindingCursor = new Map<string, number>();
  constructor(
    readonly options: {
      database: Kysely<Database>;
      bindings: SandboxBindingView;
      retention: RuntimeRetention;
      probes: ExecutionPathProbes;
      managementToken: string;
      fetch?: typeof fetch;
    },
  ) {}

  start(): void {
    this.#timer = setInterval(() => {
      if (this.#closed || this.#tick) return;
      this.#tick = this.tick()
        .catch(() => {
          operationalLog({
            service: "pi-cloud-session-runtime",
            level: "warn",
            event: "execution.maintenance_deferred",
          });
        })
        .finally(() => {
          this.#tick = undefined;
        });
    }, 5000);
    this.#timer.unref();
  }

  async #families(writerId?: string): Promise<Family[]> {
    const result =
      await sql<Family>`select e.tenant_id,e.pi_session_id,e.run_id,e.session_id,e.turn_id,
      e.writer_id,e.fencing_token::text,
      extract(epoch from (e.valid_until-clock_timestamp()))*1000 as remaining_ms,
      w.boot_id,h.management_base_url,
      coalesce((select jsonb_agg(distinct jsonb_build_object('id',runtime.workspace_runtime_id,'capsule',runtime.runtime_capsule)) from (
        select r.workspace_id,r.compute_session_id where s.execution_mode='elastic' or r.compute_session_id is not null
        union
        select cs.workspace_id,cs.compute_session_id from subagent_executions child
          join sessions cs on cs.tenant_id=child.tenant_id and cs.id=child.child_session_id
          where child.tenant_id=e.tenant_id and child.root_run_id=e.run_id
            and child.state in ('preparing','running') and (cs.execution_mode='elastic' or cs.compute_session_id is not null)
      ) refs join workspace_runtimes runtime on runtime.tenant_id=e.tenant_id
        and runtime.workspace_id=refs.workspace_id and runtime.compute_session_id is not distinct from refs.compute_session_id
        and not runtime.allocation_closed and runtime.state='allocated' and runtime.runtime_capsule is not null),'[]'::jsonb) as resources
      from active_execution_scopes e join session_leases l on l.lease_id=e.lease_id
      join runs r on r.id=e.run_id join sessions s on s.id=r.session_id
      join workers w on w.id=e.worker_id join supervisor_hosts h on h.supervisor_id=w.supervisor_id
      where e.accepting_effects and e.valid_until>clock_timestamp() and l.tool_bindings_closed_at is null
        and ${writerId ? sql`e.writer_id=${writerId}::uuid` : sql`abs(hashtextextended(e.writer_id::text,0)%12)=floor(extract(epoch from clock_timestamp())/5)::bigint%12`}
      order by e.writer_id`.execute(this.options.database);
    return result.rows;
  }
  #scope(family: Family): RuntimeObservationScope {
    return {
      tenantId: family.tenant_id,
      piSessionId: family.pi_session_id,
      runId: family.run_id,
      sessionId: family.session_id,
      turnId: family.turn_id,
      writerId: family.writer_id,
      fencingToken: Number(family.fencing_token),
    };
  }
  #current(family: Family, started: number) {
    const owns = this.options.bindings.owner(family.pi_session_id);
    const until = started + Math.max(0, Number(family.remaining_ms));
    return () => !this.#closed && owns?.() === true && performance.now() < until;
  }
  async tick(): Promise<void> {
    const started = performance.now();
    const families = await this.#families();
    for (const family of families) {
      const current = this.#current(family, started);
      if (!current()) continue;
      for (const target of family.resources)
        this.options.retention.retain(target, {
          writerId: family.writer_id,
          observedAt: Date.now(),
          current,
        });
    }
    // Oldest diagnostic first. At capacity, skip diagnostics rather than queue
    // stale work or suppress finite renewals. A later round rotates the selection.
    families.sort(
      (a, b) => (this.#lastProbed.get(a.writer_id) ?? 0) - (this.#lastProbed.get(b.writer_id) ?? 0),
    );
    for (const family of families) {
      if (this.#probes.size >= 4) break;
      const current = this.#current(family, started);
      if (!current()) continue;
      const routes = this.options.bindings.writerBindings(family.writer_id);
      if (!routes.length) continue;
      const scope = this.#scope(family);
      const startAt = (this.#bindingCursor.get(family.writer_id) ?? 0) % routes.length;
      const selected = [...routes.slice(startAt), ...routes.slice(0, startAt)].slice(0, 64);
      this.#bindingCursor.set(family.writer_id, (startAt + selected.length) % routes.length);
      const fact: PathProbe = {
        kind: "path_probe",
        factId: randomUUID(),
        scope,
        occurredAt: new Date().toISOString(),
        execution: {
          replyTopic: toolReplyTopic(family.boot_id),
          bindings: selected.map((route) => ({
            bindingId: route.bindingId,
            probe: true,
            scope: {
              ...scope,
              sessionId: route.snapshot.assignment.sessionId,
              turnId: route.snapshot.assignment.turnId,
            },
          })),
        },
      };
      this.#lastProbed.set(family.writer_id, Date.now());
      const pending = this.#prepare(family, fact, current)
        .catch(() => {})
        .finally(() => this.#probes.delete(pending));
      this.#probes.add(pending);
    }
    for (const [writer, at] of this.#lastProbed)
      if (Date.now() - at > 5 * 60_000) {
        this.#lastProbed.delete(writer);
        this.#bindingCursor.delete(writer);
      }
  }
  async #prepare(family: Family, fact: PathProbe, current: () => boolean): Promise<void> {
    const response = await (this.options.fetch ?? fetch)(
      new URL(EXECUTION_PROBE_RECEIVER_PATH, family.management_base_url),
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(EXECUTION_PROBE_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${this.options.managementToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(fact),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return;
    }
    const received = (await response.json()) as { replyTopic?: string };
    if (received.replyTopic !== fact.execution!.replyTopic || !current()) return;
    this.options.probes.consume(fact, current);
  }
  /** The fault caller registered its own receiver before this HTTP request. */
  async request(fact: PathProbe): Promise<boolean> {
    const started = performance.now();
    const family = (await this.#families(fact.scope.writerId))[0];
    if (
      !family ||
      !fact.execution ||
      fact.execution.replyTopic !== toolReplyTopic(family.boot_id) ||
      family.tenant_id !== fact.scope.tenantId ||
      family.pi_session_id !== fact.scope.piSessionId ||
      family.run_id !== fact.scope.runId ||
      Number(family.fencing_token) !== fact.scope.fencingToken
    )
      return false;
    const current = this.#current(family, started);
    if (!current()) return false;
    this.options.probes.consume(fact, current);
    return true;
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    await this.#tick;
    await Promise.allSettled(this.#probes);
  }
}
