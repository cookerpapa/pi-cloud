import { sql, type Kysely } from "kysely";
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    alter table agent_revisions drop constraint agent_revisions_session_storage_kind_check;
    update agent_revisions set state='retired' where state='active';
    insert into agent_revisions(id,definition_id,revision_number,runtime_kind,runtime_version,harness_version,session_storage_kind,state)
      values('b8770920-7434-4daf-ad3e-ded45368764f','904b0a62-f7ab-4da6-a86a-1328f76d1eea',2,
        'pi_sdk','1.0.0','pi-cloud-durable-v1','pi_durable_storage_v1','active');
    alter table sessions alter column agent_revision_id set default 'b8770920-7434-4daf-ad3e-ded45368764f'::uuid;
    alter table runs alter column agent_revision_id set default 'b8770920-7434-4daf-ad3e-ded45368764f'::uuid;
    delete from agent_revisions where state='retired';
    alter table agent_revisions add check(session_storage_kind in ('pi_durable_storage_v1'));
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error("Restore the matched pre-Durable deployment to revert runtime identity");
}
