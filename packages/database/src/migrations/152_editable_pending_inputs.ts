import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table turn_control_requests drop constraint turn_control_requests_kind_check;
    alter table turn_control_requests add constraint turn_control_requests_kind_check
      check (kind in ('cancel','steer','queue'));
    alter table turn_control_requests add constraint turn_control_requests_tenant_id_id_unique unique(tenant_id,id);
    alter table runs add column queued_steer_id uuid;
    alter table runs add constraint runs_queued_steer_tenant_fk
      foreign key(tenant_id,queued_steer_id) references turn_control_requests(tenant_id,id);
    alter table runs add constraint runs_queued_steer_not_ready
      check (queued_steer_id is null or ready_at is null);
    create index runs_pending_steer on runs(queued_steer_id)
      where state='queued' and queued_steer_id is not null;
    create index runs_pending_inputs_session on runs(tenant_id,session_id,mailbox_position)
      where state='queued';
    alter table runs drop constraint runs_session_mailbox_unique;
    alter table runs add constraint runs_session_mailbox_unique
      unique (session_id, mailbox_position) deferrable initially immediate;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    do $$ begin
      if exists(select 1 from runs where state='queued' and queued_steer_id is not null) then
        raise exception 'Pending steer promotions must settle before rollback';
      end if;
    end $$;
    alter table runs drop constraint runs_queued_steer_not_ready;
    alter table runs drop column queued_steer_id;
    drop index runs_pending_inputs_session;
    alter table turn_control_requests drop constraint turn_control_requests_tenant_id_id_unique;
    delete from turn_control_requests where kind='queue';
    alter table turn_control_requests drop constraint turn_control_requests_kind_check;
    alter table turn_control_requests add constraint turn_control_requests_kind_check
      check (kind in ('cancel','steer'));
    alter table runs drop constraint runs_session_mailbox_unique;
    alter table runs add constraint runs_session_mailbox_unique unique (session_id, mailbox_position);
  `.execute(db);
}
