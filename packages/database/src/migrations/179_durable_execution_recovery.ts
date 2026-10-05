import { sql, type Kysely } from "kysely";

/** A logical Run can reacquire execution only after the prior physical writer
 * has been sealed through Kafka. This is not a second task/attempt ledger. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    alter table runs add column recovery_requested_at timestamptz;
    create or replace function pi_cloud_count_unsealed_runs() returns trigger language plpgsql as $$
    declare change integer;
    begin
      if TG_OP='INSERT' then
        change := case when new.lease_id is not null and new.output_sealed_at is null then 1 else 0 end;
      else
        if old.lease_id is not null and new.lease_id is distinct from old.lease_id then
          if new.lease_id is not null or old.execution_released_at is null
            or not exists(select 1 from session_leases l where l.lease_id=old.lease_id and l.writer_seal_offset is not null)
          then raise exception 'Seal and release the previous native writer before recovery'; end if;
        end if;
        change := (case when new.lease_id is not null and new.output_sealed_at is null then 1 else 0 end)
          - (case when old.lease_id is not null and old.output_sealed_at is null then 1 else 0 end);
      end if;
      if change<>0 then
        update pi_sessions p set unsealed_runs=p.unsealed_runs+change from sessions s
          where s.id=new.session_id and s.tenant_id=new.tenant_id and p.id=s.pi_session_id and p.tenant_id=s.tenant_id;
        if not found then raise exception 'Run lost its physical Session'; end if;
      end if;
      return new;
    end $$;
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error("Drain Durable owners and restore matching runtime before reverting recovery");
}
