-- Research schemas only. The runner clones the current migrated schema first.
-- Never apply this file to a PiCloud deployment. {{schema}} is a fixed study name.
set search_path = {{schema}}, public;

alter table pi_session_log
  add column item_id text generated always as (payload -> kind ->> 'id') stored,
  add column item_type text generated always as (payload -> kind ->> 'type') stored,
  add column parent_id text generated always as (payload #>> '{entry,parentId}') stored,
  add column custom_type text generated always as (payload #>> '{entry,customType}') stored,
  add column lane text generated always as (
    case when kind = 'entry' then payload ->> 'lane' else payload #>> '{record,lane}' end
  ) stored,
  add column run_id text generated always as (
    case when payload #>> '{record,type}' = 'operation_started'
      then payload #>> '{record,id}' else payload #>> '{record,runId}' end
  ) stored,
  add column operation_kind text generated always as (payload #>> '{record,intent,kind}') stored,
  add column timestamp_ms bigint generated always as ((payload -> kind ->> 'timestamp')::bigint) stored,
  add column turn_id uuid generated always as ((payload ->> 'turnId')::uuid) stored;

create unique index log_item_id on pi_session_log(tenant_id, session_id, item_id)
  where item_id is not null;
create index log_entry_seq on pi_session_log(tenant_id, session_id, seq) where kind = 'entry';
create index log_entry_type on pi_session_log(tenant_id, session_id, item_type, seq) where kind = 'entry';
create index log_entry_parent on pi_session_log(tenant_id, session_id, parent_id) where kind = 'entry';
create index log_record_seq on pi_session_log(tenant_id, session_id, seq) where kind = 'record';
create index log_record_query on pi_session_log(tenant_id, session_id, lane, item_type, run_id, seq)
  where kind = 'record';
create index log_turn on pi_session_log(tenant_id, turn_id, kind, seq) where turn_id is not null;
create index log_turn_message on pi_session_log(tenant_id, turn_id, seq desc)
  where kind = 'entry' and item_type = 'message' and turn_id is not null;

-- Read-only test adapters let the *existing* SessionStorage queries exercise
-- the candidate. These views are not a proposed compatibility/write layer.
create view pi_session_entries as
select tenant_id, session_id, item_id as id, seq, parent_id, item_type as type,
       custom_type, timestamp_ms, payload -> 'entry' as payload, turn_id
from pi_session_log where kind = 'entry';
create view pi_session_records as
select tenant_id, session_id, item_id as id, seq, lane, item_type as type,
       run_id, operation_kind, timestamp_ms, payload -> 'record' as payload, turn_id
from pi_session_log where kind = 'record';
