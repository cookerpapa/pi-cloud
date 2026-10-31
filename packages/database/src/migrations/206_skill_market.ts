import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table skill_packages (
      id uuid primary key, tenant_id uuid not null references tenants(id) on delete cascade,
      owner_user_id uuid not null references users(id), name text not null,
      created_at timestamptz not null default clock_timestamp(),
      unique(tenant_id,id), unique(tenant_id,owner_user_id,name)
    );
    create table skill_versions (
      id uuid primary key, tenant_id uuid not null, package_id uuid not null,
      digest text not null, object_key text not null, byte_length bigint not null,
      label text not null, description text not null, compatibility text not null,
      requirements jsonb not null, source jsonb not null, published boolean not null default false,
      created_at timestamptz not null default clock_timestamp(),
      foreign key(tenant_id,package_id) references skill_packages(tenant_id,id) on delete cascade,
      unique(tenant_id,id), unique(tenant_id,package_id,digest), unique(tenant_id,package_id,id)
    );
    create index skill_versions_package on skill_versions(tenant_id,package_id,created_at desc,id) where published;
    create table skill_installations (
      tenant_id uuid not null, package_id uuid not null, version_id uuid not null,
      scope_kind text not null check(scope_kind in ('personal','tenant','project')), scope_id uuid not null,
      enabled boolean not null, revision bigint not null default 1,
      primary key(tenant_id,scope_kind,scope_id,package_id),
      foreign key(tenant_id,package_id,version_id) references skill_versions(tenant_id,package_id,id) on delete cascade
    );
    create table run_skill_catalogs (
      tenant_id uuid not null references tenants(id) on delete cascade,
      run_id uuid primary key,
      versions jsonb not null, created_at timestamptz not null default clock_timestamp(),
      foreign key(tenant_id,run_id) references runs(tenant_id,id) on delete cascade
    );
  `.execute(db);
}
export async function down(): Promise<void> {
  throw new Error("Use a matched Skill market release");
}
