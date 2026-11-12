import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { WorkspaceQuotaClient, WorkspaceStorageSnapshot } from "./workspace-quota-client.ts";
import {
  validatedIdentity,
  validatedVolumeIdentity,
  WorkspaceVolumeGatewayError,
  workspaceVolumeId,
  type WorkspaceVolumeGateway,
  type WorkspaceVolumeGatewayIdentity,
  type WorkspaceVolumeGatewayVolumeIdentity,
} from "./workspace-volume-gateway-contract.ts";
import {
  LOCAL_WORKSPACE_PERSISTENCE,
  type WorkspacePersistence,
  type WorkspacePersistenceState,
  type WorkspaceVolumeReference,
} from "./workspace-persistence.ts";

type Row = {
  persistence_state: "uninitialized" | "adoption_pending" | "initializing" | "ready";
  persistence_generation: string | null;
  storage_pool_id: string | null;
  capacity_pending: boolean;
  deleted_at: Date | null;
  storage_purged_at: Date | null;
};
const unavailable = (message: string): never => {
  throw new WorkspaceVolumeGatewayError("workspace_storage_unconfirmed", message, true);
};

/** PG intent + the existing storage endpoint. Never a VM or Worker authority. */
export class PostgresWorkspacePersistence implements WorkspacePersistence {
  readonly capabilities = LOCAL_WORKSPACE_PERSISTENCE;
  constructor(
    readonly options: {
      database: Pick<Pool, "query">;
      storage: Pick<
        WorkspaceQuotaClient,
        "pool" | "inspectStorage" | "prepareStorage" | "destroyStorage"
      >;
      files: Pick<WorkspaceVolumeGateway, "verify" | "prepareDelete" | "finalizeDelete">;
    },
  ) {}
  async bindEmptyDomain(domainId: string) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(domainId)) throw new TypeError("Invalid storage domain");
    const pool = await this.options.storage.pool();
    await this.options.database.query(
      `update sandbox_domains d set storage_pool_id=$2
      where d.id=$1 and d.storage_pool_id is null and not exists(
        select 1 from workspaces w where w.sandbox_domain_id=d.id and w.storage_purged_at is null)`,
      [domainId, pool.id],
    );
    const current = await this.options.database.query<{ storage_pool_id: string | null }>(
      `select storage_pool_id from sandbox_domains where id=$1`,
      [domainId],
    );
    if (!current.rows[0]) return unavailable("Storage domain has not been bootstrapped");
    if (current.rows[0]?.storage_pool_id && current.rows[0].storage_pool_id !== pool.id)
      return unavailable("Registered storage pool does not match this endpoint");
    return { poolId: pool.id, needsAdoption: current.rows[0]?.storage_pool_id === null };
  }
  async #row(input: WorkspaceVolumeGatewayVolumeIdentity): Promise<Row> {
    validatedVolumeIdentity(input);
    const result = await this.options.database.query<Row>(
      `select w.persistence_state,w.persistence_generation,d.storage_pool_id,w.capacity_pending,w.deleted_at,w.storage_purged_at
      from workspaces w join sandbox_domains d on d.id=w.sandbox_domain_id
      where w.tenant_id=$1::uuid and w.id=$2::uuid`,
      [input.tenantId, input.workspaceId],
    );
    const row = result.rows[0];
    if (!row) return unavailable("Workspace storage identity is unavailable");
    if (!row.storage_pool_id) return unavailable("Workspace storage pool is not registered");
    return row;
  }
  #request(input: WorkspaceVolumeGatewayVolumeIdentity, row: Row) {
    return {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      volumeId: input.volumeId,
      poolId: row.storage_pool_id!,
      ...(row.persistence_generation ? { generation: row.persistence_generation } : {}),
    };
  }
  #reference(
    input: WorkspaceVolumeGatewayVolumeIdentity,
    row: Row,
    snapshot: WorkspaceStorageSnapshot,
  ): WorkspaceVolumeReference {
    if (
      snapshot.volumeId !== input.volumeId ||
      snapshot.poolId !== row.storage_pool_id ||
      !snapshot.generation ||
      (row.persistence_generation && snapshot.generation !== row.persistence_generation)
    )
      return unavailable("Workspace storage receipt changed");
    return {
      kind: "volume",
      volumeId: input.volumeId,
      generation: snapshot.generation,
      poolId: snapshot.poolId,
    };
  }
  async #settle(
    input: WorkspaceVolumeGatewayIdentity,
    row: Row,
    snapshot: WorkspaceStorageSnapshot,
  ) {
    if (!snapshot.ready)
      return unavailable("Workspace initialization has not been confirmed; it will not be resent");
    const reference = this.#reference(input, row, snapshot);
    await this.options.files.verify(input);
    const result = await this.options.database.query(
      `update workspaces set persistence_state='ready'
      where tenant_id=$1::uuid and id=$2::uuid and persistence_generation=$3 and deleted_at is null
      and persistence_state in ('initializing','ready') returning id`,
      [input.tenantId, input.workspaceId, reference.generation],
    );
    if (!result.rowCount) return unavailable("Workspace changed during initialization");
    return reference;
  }
  async ensure(input: WorkspaceVolumeGatewayIdentity): Promise<WorkspaceVolumeReference> {
    validatedIdentity(input);
    let row = await this.#row(input);
    if (row.deleted_at || row.storage_purged_at) return unavailable("Workspace is being deleted");
    if (row.persistence_state === "adoption_pending")
      return unavailable("Workspace storage needs the recorded cold adoption");
    if (row.persistence_state === "ready" || row.persistence_state === "initializing") {
      const snapshot = await this.options.storage.inspectStorage(this.#request(input, row));
      if (row.persistence_state === "ready") {
        if (!snapshot.ready)
          return unavailable(
            "Retained Workspace storage is missing; no empty replacement was created",
          );
        return this.#reference(input, row, snapshot);
      }
      return this.#settle(input, row, snapshot);
    }
    const generation = randomBytes(32).toString("hex");
    const claimed = await this.options.database.query(
      `update workspaces set persistence_state='initializing',persistence_generation=$3
      where tenant_id=$1::uuid and id=$2::uuid and deleted_at is null and persistence_state='uninitialized' returning id`,
      [input.tenantId, input.workspaceId, generation],
    );
    if (!claimed.rowCount) return this.ensure(input);
    row = { ...row, persistence_state: "initializing", persistence_generation: generation };
    const snapshot = await this.options.storage.prepareStorage({
      ...this.#request(input, row),
      generation,
      initialize: true,
      adopt: false,
    });
    return this.#settle(input, row, snapshot);
  }
  async inspect(input: WorkspaceVolumeGatewayVolumeIdentity): Promise<WorkspacePersistenceState> {
    const row = await this.#row(input);
    if (row.storage_purged_at) return { state: "deleted" };
    if (row.persistence_state === "uninitialized") return { state: "uninitialized" };
    const observation = await this.options.storage.inspectStorage(this.#request(input, row));
    if (!observation.ready)
      return { state: row.persistence_state === "initializing" ? "initializing" : "unavailable" };
    return { state: "ready", reference: this.#reference(input, row, observation) };
  }
  async prepareDelete(input: WorkspaceVolumeGatewayVolumeIdentity) {
    const row = await this.#deleteRow(input);
    const result = await this.options.files.prepareDelete(input);
    if (!result.prepared) {
      const state = await this.options.storage.inspectStorage(this.#request(input, row));
      if (state.exists)
        return unavailable("Storage and file endpoints disagree about Workspace presence");
    }
    return { prepared: true };
  }
  async finalizeDelete(input: WorkspaceVolumeGatewayVolumeIdentity) {
    const row = await this.#deleteRow(input);
    if (row.persistence_generation)
      await this.options.storage.destroyStorage({
        ...this.#request(input, row),
        generation: row.persistence_generation,
      });
    else {
      const state = await this.options.storage.inspectStorage(this.#request(input, row));
      if (state.exists || state.known)
        return unavailable("Uninitialized Workspace has unexpected physical storage");
    }
    await this.options.files.finalizeDelete(input);
    const state = await this.options.storage.inspectStorage(this.#request(input, row));
    if (state.exists) return unavailable("Workspace envelope deletion is unconfirmed");
    return { deleted: true };
  }
  async #deleteRow(input: WorkspaceVolumeGatewayVolumeIdentity) {
    let row = await this.#row(input);
    if (!row.deleted_at) return unavailable("Workspace deletion is not admitted");
    const active = await this.options.database.query(
      `select 1 from workspace_runtimes where tenant_id=$1::uuid and workspace_id=$2::uuid and state<>'released'
      union all select 1 from development_environments where tenant_id=$1::uuid and workspace_id=$2::uuid and (not allocation_closed or not allocation_absent)
      union all select 1 from workspace_terminal_sessions where tenant_id=$1::uuid and workspace_id=$2::uuid and state<>'released' limit 1`,
      [input.tenantId, input.workspaceId],
    );
    if (active.rowCount) return unavailable("Physical Workspace users have not retired");
    if (row.persistence_state === "initializing") {
      const original = await this.options.storage.inspectStorage(this.#request(input, row));
      if (!original.ready) return unavailable("Resolve Workspace initialization before deletion");
      this.#reference(input, row, original);
      await this.options.database.query(
        `update workspaces set persistence_state='ready' where tenant_id=$1::uuid and id=$2::uuid and persistence_state='initializing' and persistence_generation=$3`,
        [input.tenantId, input.workspaceId, row.persistence_generation],
      );
      row = await this.#row(input);
    }
    if (row.persistence_state === "adoption_pending")
      return unavailable("Adopt retained Workspace storage before deletion");
    return row;
  }
  /** Operator-only cold adoption; ordinary ensure never recreates an old layout. */
  adoptDomain(domainId: string) {
    return adoptWorkspacePersistenceDomain(this.options, domainId);
  }
}

async function assertColdDomain(database: Pick<Pool, "query">, domainId: string) {
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(domainId)) throw new TypeError("Invalid storage domain");
  const active = await database.query(
    `select 1 from workspace_runtimes where sandbox_domain_id=$1 and state<>'released'
      union all select 1 from development_environments where sandbox_domain_id=$1 and (not allocation_closed or not allocation_absent)
      union all select 1 from workspace_terminal_sessions where sandbox_domain_id=$1 and state<>'released' limit 1`,
    [domainId],
  );
  if (active.rowCount) return unavailable("Retire physical storage consumers before adoption");
}

export async function adoptWorkspacePersistenceDomain(
  options: Pick<PostgresWorkspacePersistence["options"], "database" | "storage">,
  domainId: string,
) {
  await assertColdDomain(options.database, domainId);
  const pool = await options.storage.pool();
  const bound = await options.database.query(
    `update sandbox_domains set storage_pool_id=$2 where id=$1 and (storage_pool_id is null or storage_pool_id=$2) returning id`,
    [domainId, pool.id],
  );
  if (bound.rowCount !== 1)
    return unavailable("Storage pool identity differs from its registered backend");
  let adopted = 0;
  for (;;) {
    const workspaces = await options.database.query<{
      tenant_id: string;
      id: string;
      prior_storage_use: boolean;
      deleted_at: Date | null;
    }>(
      `select w.tenant_id,w.id,w.deleted_at,
        (exists(select 1 from workspace_runtimes r where r.workspace_id=w.id)
         or exists(select 1 from development_environments d where d.workspace_id=w.id)
         or exists(select 1 from workspace_terminal_sessions t where t.workspace_id=w.id)
         or exists(select 1 from workspace_file_transfers f where f.workspace_id=w.id)
         or exists(select 1 from session_uploads u where u.workspace_id=w.id)) as prior_storage_use
       from workspaces w where w.sandbox_domain_id=$1 and w.persistence_state='adoption_pending'
       and w.storage_purged_at is null order by w.id limit 64`,
      [domainId],
    );
    for (const workspace of workspaces.rows) {
      await assertColdDomain(options.database, domainId);
      const identity = {
        tenantId: workspace.tenant_id,
        workspaceId: workspace.id,
        volumeId: workspaceVolumeId({ tenantId: workspace.tenant_id, workspaceId: workspace.id }),
      };
      const observed = await options.storage.inspectStorage({
        ...identity,
        poolId: pool.id,
      });
      if (observed.exists) {
        if (!observed.generation) return unavailable("Existing Workspace identity is incomplete");
        await options.storage.prepareStorage({
          ...identity,
          poolId: pool.id,
          generation: observed.generation,
          initialize: false,
          adopt: true,
        });
        await options.database.query(
          `update workspaces set persistence_state='ready',persistence_generation=$3 where tenant_id=$1::uuid and id=$2::uuid and persistence_state='adoption_pending'`,
          [workspace.tenant_id, workspace.id, observed.generation],
        );
      } else {
        if (observed.known || workspace.prior_storage_use)
          return unavailable("Previously initialized Workspace bytes are unavailable");
        await options.database.query(
          `update workspaces set persistence_state='uninitialized' where tenant_id=$1::uuid and id=$2::uuid and persistence_state='adoption_pending'`,
          [workspace.tenant_id, workspace.id],
        );
      }
      adopted++;
    }
    if (workspaces.rows.length < 64) break;
  }
  return { poolId: pool.id, adopted };
}
