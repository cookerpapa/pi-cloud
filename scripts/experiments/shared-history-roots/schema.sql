-- Disposable experiment database only. This is not a production migration.
create table lab_streams (
  id uuid primary key,
  tenant uuid not null,
  start_id bigint not null,
  last_id bigint not null,
  records bigint not null default 0,
  bytes bigint not null default 0,
  head_id bigint,
  digest text not null
);
create table lab_entries (
  stream uuid not null references lab_streams(id),
  id bigint not null,
  seq bigint not null,
  body text not null,
  body_sha text not null,
  body_bytes integer not null,
  presentation text not null,
  presentation_sha text not null,
  metadata_sha text not null,
  head bigint,
  prefix_records bigint,
  prefix_bytes bigint,
  prefix_head bigint,
  prefix_digest text,
  primary key(stream,id)
);
create index lab_entries_heads on lab_entries(stream,id desc) where head is not null;
create table lab_nodes (
  id uuid primary key,
  tenant uuid not null,
  left_id uuid references lab_nodes(id),
  right_id uuid references lab_nodes(id),
  stream uuid references lab_streams(id),
  through_id bigint,
  through_seq bigint,
  min_id bigint not null,
  max_id bigint not null,
  height integer not null,
  records bigint not null,
  bytes bigint not null,
  head_id bigint,
  prefix_digest text,
  digest text not null,
  check ((stream is not null and left_id is null and right_id is null and height=1)
    or (stream is null and left_id is not null and right_id is not null and height>1))
);
create index lab_nodes_left on lab_nodes(left_id) where left_id is not null;
create index lab_nodes_right on lab_nodes(right_id) where right_id is not null;
create index lab_nodes_stream on lab_nodes(stream,through_id) where stream is not null;
create table lab_views (
  id uuid primary key,
  tenant uuid not null,
  base uuid references lab_nodes(id),
  stream uuid not null references lab_streams(id),
  seq bigint not null default 0,
  next_id bigint not null default 2,
  generation integer not null default 0,
  read_only boolean not null default false,
  request_key text,
  request_source uuid,
  request_at bigint,
  unique(tenant,request_key)
);
create index lab_views_base on lab_views(base) where base is not null;
create index lab_views_stream on lab_views(stream);
create table lab_receipts (
  view_id uuid not null references lab_views(id) on delete cascade,
  seq bigint not null,
  digest text not null,
  primary key(view_id,seq)
);
create table lab_pins (
  id uuid primary key,
  tenant uuid not null,
  root uuid not null references lab_nodes(id)
);
create index lab_pins_root on lab_pins(root);
create table lab_assets (
  id uuid primary key,
  tenant uuid not null,
  bytes bytea not null
);
create table lab_entry_assets (
  stream uuid not null,
  entry_id bigint not null,
  asset uuid not null references lab_assets(id),
  primary key(stream,entry_id,asset),
  foreign key(stream,entry_id) references lab_entries(stream,id) on delete cascade
);
create index lab_entry_assets_asset on lab_entry_assets(asset);
create table lab_asset_pins (
  id uuid primary key,
  asset uuid not null references lab_assets(id)
);
