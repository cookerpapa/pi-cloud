import { sql, type Kysely } from "kysely";

/** The selected Agent profile remains distinct from its provider Max effort. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`do $$ begin
    if exists(select 1 from session_leases where released_at is null) then
      raise exception 'Drain Session writers before upgrading Agent profiles';
    end if;
  end $$;
  alter table model_profiles drop constraint model_profiles_thinking_levels_valid,
    add constraint model_profiles_thinking_levels_valid check (
      cardinality(allowed_thinking_levels)>0 and
      allowed_thinking_levels <@ array['off','minimal','low','medium','high','xhigh','max','ultra']::text[] and
      default_thinking_level=any(allowed_thinking_levels));
  alter table sessions drop constraint sessions_desired_thinking_level_valid,
    add constraint sessions_desired_thinking_level_valid check (
      desired_thinking_level in ('off','minimal','low','medium','high','xhigh','max','ultra'));
  alter table runs drop constraint runs_thinking_level_valid,
    add constraint runs_thinking_level_valid check (
      thinking_level in ('off','minimal','low','medium','high','xhigh','max','ultra'));
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Ultra profiles require the matched application contract");
}
