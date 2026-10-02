import { sql, type Kysely } from "kysely";

/** One stable hash, not a second routing authority. Matches JS UTF-16 FNV-1a. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    create function pi_cloud_session_hash(value text) returns bigint
      language plpgsql immutable strict parallel safe as $$
    declare h bigint := 2166136261; code integer; ch text;
    begin
      foreach ch in array string_to_array(value, null) loop
        code := ascii(ch);
        if code > 65535 then
          code := code - 65536;
          h := ((h # (55296 + (code >> 10))::bigint) * 16777619) % 4294967296;
          code := 56320 + (code & 1023);
        end if;
        h := ((h # code::bigint) * 16777619) % 4294967296;
      end loop;
      return h;
    end $$;
    alter table pi_sessions add column session_hash bigint
      generated always as (pi_cloud_session_hash(id)) stored;
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error("Restore the matched database/application before partition-filtered admission");
}
