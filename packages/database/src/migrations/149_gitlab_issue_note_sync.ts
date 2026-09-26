import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    do $$ begin
      if exists(select 1 from source_control_issue_jobs
        where owner_id is not null and lease_expires_at > clock_timestamp())
      then raise exception 'Stop Issue reconciliation before replacing GitLab note synchronization'; end if;
    end $$;

    create table gitlab_issue_note_sync (
      issue_job_id uuid primary key,
      tenant_id uuid not null,
      desired_version bigint not null default 1 check (desired_version > 0),
      synced_version bigint not null default 0 check (synced_version >= 0 and synced_version <= desired_version),
      note_id text check (note_id ~ '^[1-9][0-9]{0,30}$'),
      claim_token uuid,
      lease_expires_at timestamptz,
      available_at timestamptz not null default clock_timestamp(),
      checked_at timestamptz,
      failure_count integer not null default 0 check (failure_count between 0 and 30),
      failure_code text check (failure_code ~ '^[a-z_]{1,64}$'),
      check ((claim_token is null) = (lease_expires_at is null)),
      foreign key (tenant_id, issue_job_id) references source_control_issue_jobs(tenant_id, id) on delete cascade
    );
    create index gitlab_issue_note_sync_due on gitlab_issue_note_sync(available_at, issue_job_id);

    create function invalidate_gitlab_issue_note(target_tenant uuid, target_job uuid)
    returns void language sql as $$
      insert into gitlab_issue_note_sync(tenant_id, issue_job_id)
        select tenant_id, id from source_control_issue_jobs
        where tenant_id = target_tenant and id = target_job and provider = 'gitlab'
      on conflict (issue_job_id) do update set
        desired_version = gitlab_issue_note_sync.desired_version + 1,
        available_at = least(gitlab_issue_note_sync.available_at, clock_timestamp()),
        failure_count = 0;
    $$;

    create function invalidate_gitlab_issue_state() returns trigger language plpgsql as $$
    begin
      if TG_OP = 'INSERT' then
        perform invalidate_gitlab_issue_note(NEW.tenant_id, NEW.id);
      elsif NEW.state is distinct from OLD.state then
        perform invalidate_gitlab_issue_note(NEW.tenant_id, NEW.id);
      end if;
      return NEW;
    end $$;
    create trigger gitlab_issue_state_changed after insert or update of state
      on source_control_issue_jobs for each row execute function invalidate_gitlab_issue_state();

    create function invalidate_gitlab_issue_claim() returns trigger language plpgsql as $$
    begin
      if TG_OP = 'DELETE' then
        perform invalidate_gitlab_issue_note(OLD.tenant_id, OLD.issue_job_id);
        return OLD;
      end if;
      if TG_OP = 'UPDATE' then
        if NEW is not distinct from OLD then return NEW; end if;
        if (NEW.tenant_id, NEW.issue_job_id) is distinct from (OLD.tenant_id, OLD.issue_job_id) then
          perform invalidate_gitlab_issue_note(OLD.tenant_id, OLD.issue_job_id);
        end if;
      end if;
      perform invalidate_gitlab_issue_note(NEW.tenant_id, NEW.issue_job_id);
      return NEW;
    end $$;
    create trigger gitlab_issue_claim_changed after insert or update or delete
      on source_control_issue_claims for each row execute function invalidate_gitlab_issue_claim();

    insert into gitlab_issue_note_sync(tenant_id, issue_job_id)
      select tenant_id, id from source_control_issue_jobs where provider = 'gitlab';
    alter table source_control_issue_jobs drop column claim_sync_pending;
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Restore a matched backup to roll back GitLab note synchronization");
}
