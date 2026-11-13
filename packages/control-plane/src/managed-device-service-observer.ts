import { sql, type Kysely } from "kysely";
import { isDeepStrictEqual } from "node:util";
import { type Database } from "@pi-cloud/database";
import {
  registerManagedDeviceService,
  type ManagedDeviceService,
} from "./managed-device-service.ts";
import type {
  ExecutorTransport,
  ExecutorStatus,
} from "@pi-cloud/sandbox-control/executor-transport";

type Device = {
  id: string;
  tenant_id: string;
  endpoint: string;
  compute_service: ManagedDeviceService;
};

/** Observe only operator-enrolled compute. BYO devices are not polled for billing. */
export class ManagedDeviceServiceObserver {
  #timer: NodeJS.Timeout | undefined;
  #pending: Promise<void> | undefined;
  #closed = false;
  #after = "00000000-0000-0000-0000-000000000000";
  readonly #states = new Map<string, boolean>();
  readonly #healthyMinute = new Map<string, number>();
  constructor(
    readonly database: Kysely<Database>,
    readonly transport: Pick<ExecutorTransport, "inspect">,
  ) {}
  start() {
    const run = () => {
      if (this.#closed || this.#pending) return;
      this.#pending = this.tick()
        .catch(() => {
          process.stderr.write("managed_device_observation_deferred\n");
        })
        .finally(() => {
          this.#pending = undefined;
        });
    };
    this.#timer = setInterval(run, 30_000);
    this.#timer.unref();
    run();
  }
  async tick(): Promise<void> {
    const { rows } =
      await sql<Device>`select id,tenant_id,endpoint,compute_service from execution_targets
      where compute_service is not null and enabled and id>${this.#after}::uuid order by id limit 64`.execute(
        this.database,
      );
    this.#after = rows.length === 64 ? rows.at(-1)!.id : "00000000-0000-0000-0000-000000000000";
    for (let offset = 0; offset < rows.length && !this.#closed; offset += 4)
      await Promise.allSettled(rows.slice(offset, offset + 4).map((row) => this.observe(row)));
  }
  async observe(device: Device): Promise<void> {
    let status: ExecutorStatus | undefined;
    try {
      status = await this.transport.inspect(device.endpoint);
    } catch {}
    const capacity = status?.provisionedCompute;
    const available = Boolean(
      status?.kind === "android" &&
      status.targetId === device.id &&
      status.ready &&
      capacity &&
      capacity.cpuMillis === device.compute_service.quantity.cpuMillis &&
      capacity.memoryBytes === device.compute_service.quantity.memoryBytes,
    );
    const minute = Math.floor(Date.now() / 60_000);
    if (
      available &&
      this.#states.get(device.id) === true &&
      this.#healthyMinute.get(device.id) === minute &&
      status?.bootId === device.compute_service.bootId &&
      capacity?.allocationId === device.compute_service.allocationId
    )
      return;
    const applied = await this.database.transaction().execute(async (tx) => {
      const { rows } =
        await sql<Device>`select id,tenant_id,endpoint,compute_service from execution_targets where id=${device.id}::uuid and tenant_id=${device.tenant_id}::uuid and enabled for update`.execute(
          tx,
        );
      const current = rows[0];
      if (
        !current ||
        current.endpoint !== device.endpoint ||
        !isDeepStrictEqual(current.compute_service, device.compute_service)
      )
        return false;
      const key = "compute:" + current.compute_service.allocationId;
      if (available && status && capacity) {
        if (
          capacity.allocationId !== current.compute_service.allocationId ||
          status.bootId !== current.compute_service.bootId
        ) {
          await sql`select pi_cloud_compute_service_state(${key},false,clock_timestamp(),'instance_changed')`.execute(
            tx,
          );
          const service = {
            ...current.compute_service,
            allocationId: capacity.allocationId,
            bootId: status.bootId,
          };
          await sql`update execution_targets set compute_service=${JSON.stringify(service)}::jsonb where id=${device.id}::uuid`.execute(
            tx,
          );
          await registerManagedDeviceService(tx, device.tenant_id, device.id, service);
        } else
          await sql`select pi_cloud_compute_service_state(${key},true,clock_timestamp(),'ready')`.execute(
            tx,
          );
      } else
        await sql`select pi_cloud_compute_service_state(${key},false,clock_timestamp(),'unavailable')`.execute(
          tx,
        );
      return true;
    });
    if (!applied) return;
    if (available) this.#healthyMinute.set(device.id, minute);
    else this.#healthyMinute.delete(device.id);
    if (this.#states.get(device.id) !== available) {
      this.#states.set(device.id, available);
      process.stdout.write(
        JSON.stringify({
          event: "managed_device.service_observed",
          targetId: device.id,
          available,
          observedAt: new Date().toISOString(),
          physicalStopOccurredAt: null,
        }) + "\n",
      );
    }
    // The map is disposable logging suppression, never service authority.
    if (this.#states.size > 4096) {
      this.#states.clear();
      this.#healthyMinute.clear();
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#pending;
  }
}
