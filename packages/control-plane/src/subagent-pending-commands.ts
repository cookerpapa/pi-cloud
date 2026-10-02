import type { Database } from "@pi-cloud/database";
import type { Selectable } from "kysely";
import type { AcceptedSubagentCommand } from "@pi-cloud/runtime-core/accepted-fact";

export type SubagentCommandRow = Selectable<Database["subagent_control_commands"]>;
export type PendingSubagentCommand = {
  id: string;
  tenantId: string;
  runId: string;
  partition: number;
  ordinal: bigint;
  family: string;
  responsePending: boolean;
  inputPending: boolean;
  targetSessionId: string | null;
  inputRunId: string | null;
};
export const subagentFamily = (tenant: string, session: string) => `${tenant}:${session}`;

/** Durable rows stay in PG; waiting memory contains references, with only a
 * small byte-bounded cache of bodies currently being processed. */
export class SubagentPendingCommands {
  readonly #refs = new Map<string, PendingSubagentCommand>();
  readonly #rows = new Map<string, { value: SubagentCommandRow; bytes: number }>();
  readonly #versions = new Map<string, bigint>();
  #bytes = 0;
  overflow = false;
  constructor(
    readonly maximum = 16384,
    readonly maximumBytes = 32 * 1024 * 1024,
  ) {}
  get size(): number {
    return this.#refs.size;
  }
  entries(): readonly PendingSubagentCommand[] {
    return [...this.#refs.values()];
  }
  get(id: string): PendingSubagentCommand | undefined {
    return this.#refs.get(id);
  }
  row(id: string): SubagentCommandRow | undefined {
    return this.#rows.get(id)?.value;
  }
  #dropBody(id: string): void {
    const old = this.#rows.get(id);
    if (old) this.#bytes -= old.bytes;
    this.#rows.delete(id);
  }
  releaseBody(id: string, revision?: string): void {
    if (revision === undefined || this.#rows.get(id)?.value.revision === revision)
      this.#dropBody(id);
  }
  reset(): void {
    this.#refs.clear();
    this.#rows.clear();
    this.#versions.clear();
    this.#bytes = 0;
    this.overflow = false;
  }
  remove(id: string, version?: bigint): void {
    if (version !== undefined && version < (this.#versions.get(id) ?? -1n)) return;
    this.#refs.delete(id);
    this.#dropBody(id);
    if (version !== undefined) this.#version(id, version);
  }
  #version(id: string, version: bigint): void {
    this.#versions.delete(id);
    this.#versions.set(id, version);
    if (this.#versions.size > this.maximum * 2) {
      const retired = [...this.#versions.keys()].find((key) => !this.#refs.has(key));
      if (retired) this.#versions.delete(retired);
    }
  }
  remember(row: SubagentCommandRow): boolean {
    const version = BigInt(row.revision);
    if (version < (this.#versions.get(row.id) ?? -1n)) return false;
    const command = row.command as unknown as AcceptedSubagentCommand;
    const response = row.response as { result?: { state?: unknown } } | null;
    const inputPending =
      row.target_session_id !== null &&
      row.input_consumed_at === null &&
      response?.result?.state === "accepted";
    if (row.delivered_at !== null && !inputPending) {
      this.remove(row.id, version);
      return false;
    }
    if (this.#refs.size >= this.maximum && !this.#refs.has(row.id)) {
      this.overflow = true;
      return false;
    }
    this.#version(row.id, version);
    this.#refs.set(row.id, {
      id: row.id,
      tenantId: row.tenant_id,
      runId: row.run_id,
      partition: row.partition,
      ordinal: BigInt(row.ordinal),
      family: subagentFamily(row.tenant_id, command.scope.piSessionId),
      responsePending: row.delivered_at === null,
      inputPending,
      targetSessionId: row.target_session_id,
      inputRunId: row.input_run_id,
    });
    this.#dropBody(row.id);
    const bytes = Buffer.byteLength(JSON.stringify(row));
    while (this.#rows.size && (this.#rows.size >= 128 || this.#bytes + bytes > this.maximumBytes))
      this.#dropBody(this.#rows.keys().next().value!);
    if (bytes <= this.maximumBytes) {
      this.#rows.set(row.id, { value: row, bytes });
      this.#bytes += bytes;
    }
    return true;
  }
}
