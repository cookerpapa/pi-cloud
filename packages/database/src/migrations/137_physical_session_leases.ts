import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`do $$ begin
    if exists(select 1 from session_leases)
      or exists(select 1 from runs where state in ('claimed','provisioning','restoring','running','settling','cancel_requested'))
      or exists(select 1 from outbox where published_at is null)
      or exists(select 1 from run_attempts where output_seal_id is not null and output_sealed_at is null) then
      raise exception 'Drain active execution leases before the physical Session lease cutover';
    end if;
  end $$`.execute(db);
  await sql`do $$ begin
    if exists(select 1 from development_environments where runtime_capsule is not null and state <> 'released') then
      raise exception 'Back up and release old machine instances before the execution-reference protocol cutover';
    end if;
  end $$`.execute(db);
  await sql`drop table session_leases`.execute(db);
  await sql`drop index run_attempts_one_lease`.execute(db);
  await sql`alter table run_attempts add column execution_released_at timestamptz`.execute(db);
  await sql`alter table pi_sessions add column lease_epoch bigint not null default 0 check(lease_epoch >= 0)`.execute(
    db,
  );
  await sql`update pi_sessions p set lease_epoch=coalesce((select max(s.last_fencing_token) from sessions s
    where s.tenant_id=p.tenant_id and s.pi_session_id=p.id),0)`.execute(db);
  await sql`alter table sessions drop column last_fencing_token`.execute(db);
  await sql`create table session_leases (
    tenant_id uuid not null,
    pi_session_id text not null,
    lease_id uuid not null unique,
    sandbox_id uuid not null references sandboxes(id),
    writer_id uuid not null references run_attempts(id),
    fencing_token bigint not null check(fencing_token>0),
    valid_until timestamptz not null,
    acquired_at timestamptz not null default now(),
    renewed_at timestamptz not null default now(),
    primary key (tenant_id,pi_session_id),
    foreign key (tenant_id,pi_session_id) references pi_sessions(tenant_id,id),
    check(valid_until>acquired_at)
  )`.execute(db);
  await sql`create index session_leases_owner on session_leases(sandbox_id,valid_until)`.execute(
    db,
  );
  await sql`create index run_attempts_active_lease on run_attempts(lease_id)
    where lease_id is not null and execution_released_at is null`.execute(db);
  await sql`create view active_execution_scopes as
    select s.id as session_id,l.lease_id,l.sandbox_id,l.fencing_token,l.tenant_id,
      s.project_id,r.workspace_id,r.id as run_id,r.turn_id,a.id as attempt_id,
      a.last_event_seq,l.valid_until,l.acquired_at,l.renewed_at,l.pi_session_id,l.writer_id,
      (r.state in ('claimed','provisioning','restoring','running','settling')
        and a.output_seal_id is null and w.native_writer_failed_at is null
        and w.native_writer_sealed_at is null) as accepting_effects
    from session_leases l
    join sessions s on s.tenant_id=l.tenant_id and s.pi_session_id=l.pi_session_id
    join runs r on r.tenant_id=s.tenant_id and r.session_id=s.id
    join run_attempts a on a.id=r.current_attempt_id and a.lease_id=l.lease_id
      and a.sandbox_id=l.sandbox_id and a.fencing_token=l.fencing_token
      and a.native_writer_id=l.writer_id
      and a.execution_released_at is null
    join run_attempts w on w.id=l.writer_id`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error(
    "Physical Session lease cutover is forward-only; restore a quiescent backup to downgrade",
  );
}
