import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  checkedGuestPosition,
  guestUuid,
  type GuestSubmit,
  type GuestCancel,
  type GuestPosition,
} from "@pi-cloud/protocol/guest";

export type GuestOperation = {
  id: string;
  scope: string;
  writer: string;
  fingerprint: string;
  token: string;
  deadline: number;
  cancelled: number;
  finished: number;
  pid: number | null;
  start: string | null;
};
export class GuestExecutorStore {
  readonly db: DatabaseSync;
  readonly bootId: string;
  constructor(
    path: string,
    readonly kernelBootId: string,
    readonly now: () => number = Date.now,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db
      .exec(`create table if not exists identity (id integer primary key check(id=1),kernel text not null,boot text not null,topic text,owner_pid integer,owner_start text,blocked integer not null default 0);
      create table if not exists positions(partition integer primary key,offset text not null);
      create table if not exists operations(id text primary key,scope text not null,writer text not null,fingerprint text not null,token text not null,deadline integer not null,cancelled integer not null default 0,finished integer not null default 0,pid integer,start text);`);
    const row = this.db.prepare("select * from identity where id=1").get();
    if (row && row.kernel !== kernelBootId)
      this.db.exec("delete from operations;delete from positions;delete from identity;");
    this.db
      .prepare("insert or ignore into identity(id,kernel,boot) values(1,?,?)")
      .run(kernelBootId, randomUUID());
    this.bootId = this.db.prepare("select boot from identity where id=1").get()!.boot as string;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("begin immediate");
    try {
      const out = fn();
      this.db.exec("commit");
      return out;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }
  own(pid: number, start: string, alive: (pid: number, start: string) => boolean): boolean {
    return this.transaction(() => {
      const old = this.db.prepare("select owner_pid,owner_start from identity where id=1").get()!;
      if (
        typeof old.owner_pid === "number" &&
        typeof old.owner_start === "string" &&
        alive(old.owner_pid, old.owner_start)
      )
        return false;
      this.db.prepare("update identity set owner_pid=?,owner_start=? where id=1").run(pid, start);
      return true;
    });
  }
  get blocked(): boolean {
    return this.db.prepare("select blocked from identity where id=1").get()!.blocked === 1;
  }
  block(): void {
    this.db.exec("update identity set blocked=1 where id=1");
  }
  assertBoot(boot: string, admission = true): void {
    if (boot !== this.bootId) throw new Error("executor_replaced");
    if (admission && this.blocked) throw new Error("runtime_quarantined");
  }
  #position(source: GuestPosition, fresh: boolean): void {
    const offset = checkedGuestPosition(source),
      identity = this.db.prepare("select topic from identity where id=1").get()!;
    if (identity.topic !== null && identity.topic !== source.topic)
      throw new Error("execution_stream_changed");
    const old = this.db
      .prepare("select offset from positions where partition=?")
      .get(source.partition);
    if (fresh && old && offset <= BigInt(old.offset as string))
      throw new Error("execution_position_stale");
    if (!old || offset > BigInt(old.offset as string))
      this.db
        .prepare(
          "insert into positions(partition,offset) values(?,?) on conflict(partition) do update set offset=excluded.offset",
        )
        .run(source.partition, offset.toString());
    if (identity.topic === null)
      this.db.prepare("update identity set topic=? where id=1").run(source.topic);
  }
  get(id: string): GuestOperation | undefined {
    return this.db.prepare("select * from operations where id=?").get(id) as
      GuestOperation | undefined;
  }
  list(): GuestOperation[] {
    return this.db.prepare("select * from operations order by deadline").all() as GuestOperation[];
  }
  admit(
    request: GuestSubmit,
    deliveryDeadline: number,
  ): { operation: GuestOperation; fresh: boolean } {
    this.assertBoot(request.bootId);
    if (
      ![request.operationId, request.scopeId, request.writerId].every(guestUuid) ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > 15 * 60_000 ||
      !Number.isSafeInteger(deliveryDeadline) ||
      deliveryDeadline <= this.now()
    )
      throw new Error("invalid_request");
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    return this.transaction(() => {
      const old = this.get(request.operationId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new Error("operation_changed");
        return { operation: old, fresh: false };
      }
      if (this.list().length >= 32) throw new Error("capacity");
      this.#position(request.source, true);
      this.db
        .prepare(
          "insert into operations(id,scope,writer,fingerprint,token,deadline) values(?,?,?,?,?,?)",
        )
        .run(
          request.operationId,
          request.scopeId,
          request.writerId,
          fingerprint,
          randomUUID(),
          Math.min(deliveryDeadline, this.now() + request.timeoutMs),
        );
      return { operation: this.get(request.operationId)!, fresh: true };
    });
  }
  cancel(request: GuestCancel): GuestOperation[] {
    this.assertBoot(request.bootId, false);
    if (
      ![request.scopeId, request.writerId].every(guestUuid) ||
      (request.operationId !== undefined && !guestUuid(request.operationId))
    )
      throw new Error("invalid_scope");
    return this.transaction(() => {
      this.#position(request.source, false);
      const matches = this.list().filter(
        (o) =>
          o.scope === request.scopeId &&
          o.writer === request.writerId &&
          !o.finished &&
          (!request.operationId || o.id === request.operationId),
      );
      for (const o of matches)
        this.db.prepare("update operations set cancelled=1 where id=?").run(o.id);
      return matches;
    });
  }
  claim(id: string, token: string, pid: number, start: string): GuestOperation {
    return this.transaction(() => {
      const o = this.get(id);
      if (!o || o.token !== token || o.finished || this.now() >= o.deadline)
        throw new Error("operation_unavailable");
      if (o.pid !== null && (o.pid !== pid || o.start !== start))
        throw new Error("operation_changed");
      this.db.prepare("update operations set pid=?,start=? where id=?").run(pid, start, id);
      return this.get(id)!;
    });
  }
  finish(id: string, token: string): void {
    const o = this.get(id);
    if (!o || o.token !== token) throw new Error("operation_changed");
    this.db.prepare("update operations set finished=1 where id=?").run(id);
  }
  release(id: string, token: string): void {
    const o = this.get(id);
    if (!o) return;
    if (o.token !== token || !o.finished) throw new Error("operation_changed");
    this.db.prepare("delete from operations where id=?").run(id);
  }
  close(): void {
    this.db.close();
  }
}
