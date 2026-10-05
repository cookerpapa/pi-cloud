import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase } from "../src/client.ts";
import type { Database } from "../src/database-types.ts";
import { up } from "../src/migrations/176_return_stopped_inputs.ts";

it("converts drained paused drafts without resuming them or deciding held Steer consumption", async () => {
  const pg = await PGlite.create();
  const socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  const db = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres`,
    maxConnections: 1,
  });
  try {
    // Only the previous migration's input/control surface is needed for this
    // conversion test. current-schema.test verifies the entire migration chain.
    await sql`
      create table session_leases(released_at timestamptz);
      create table outbox(aggregate_type text,published_at timestamptz);
      create table turn_control_requests(id uuid primary key,tenant_id uuid,session_id uuid,kind text,created_at timestamptz);
      create table turns(id uuid primary key,tenant_id uuid,state text,stop_reason text,settled_at timestamptz,input_text text);
      create table runs(id uuid primary key,tenant_id uuid,session_id uuid,turn_id uuid,state text,
        lease_id uuid,output_sealed_at timestamptz,ready_at timestamptz,queued_steer_id uuid,
        mailbox_position bigint,input_paused boolean,stop_reason text,settled_at timestamptz,
        updated_at timestamptz,row_version bigint);
      create table run_transitions(id uuid,tenant_id uuid,run_id uuid,from_state text,to_state text,reason text,occurred_at timestamptz);
      create function pi_cloud_input_queue_change(uuid,uuid,boolean default false) returns void language sql as 'select';
      create function pi_cloud_input_queue_run_change() returns trigger language plpgsql as $$begin return NEW; end$$;
      create trigger input_queue_run_change after update on runs for each row execute function pi_cloud_input_queue_run_change();
      insert into turn_control_requests values('00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','cancel',now());
      insert into turns select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
        '00000000-0000-4000-8000-000000000001','queued',null,null,'draft '||n from generate_series(10,12) n;
      insert into runs select id,tenant_id,'00000000-0000-4000-8000-000000000002',id,'queued',
        null,null,null,case when input_text='draft 11' then '00000000-0000-4000-8000-000000000004'::uuid end,
        row_number() over(order by id),input_text<>'draft 12',null,null,now(),1 from turns;
    `.execute(db);
    await db.transaction().execute((tx) => up<Database>(tx));
    const result = await sql<{ state: string; returned: boolean; text: string }>`
      select r.state,r.input_return_request_id is not null as returned,t.input_text as text
      from runs r join turns t on t.id=r.turn_id order by r.mailbox_position`.execute(db);
    expect(result.rows).toEqual([
      { state: "cancelled", returned: true, text: "draft 10" },
      { state: "queued", returned: true, text: "draft 11" },
      { state: "queued", returned: false, text: "draft 12" },
    ]);
    expect((await sql`select * from run_transitions`.execute(db)).rows).toHaveLength(1);
  } finally {
    await db.destroy();
    await socket.stop();
    await pg.close();
  }
}, 30_000);
