import { createServer } from "node:http";
import { sql } from "kysely";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { ANDROID_CAPABILITIES } from "@pi-cloud/protocol";
import { ResourceBackendController } from "../src/resource-backend-controller.ts";
import { ResourceBackendService } from "../src/resource-backend-service.ts";
import { registerResourceDevice } from "../src/execution-target-registration.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";

const request = () => ({
  tenantId: randomUUID(),
  device: {
    targetId: randomUUID(),
    name: "Owned device",
    endpoint: "http://device:8090",
  },
});

it("requires a platform administrator and forwards the explicitly selected organization", async () => {
  const body = request(),
    registerDevice = vi.fn(async () => ({ targetId: body.device.targetId }));
  const allowed = vi.fn(() => true);
  const controller = new ResourceBackendController(
    { registerDevice } as never,
    { requireMutation: () => ({ tenantId: randomUUID(), role: "owner" }) } as never,
    { isPlatformAdministrator: allowed } as never,
  );
  await controller.registerDevice({} as never, body);
  expect(registerDevice).toHaveBeenCalledExactlyOnceWith(body);
  allowed.mockReturnValue(false);
  await expect(controller.registerDevice({} as never, body)).rejects.toThrow(
    "platform administrator",
  );
  expect(registerDevice).toHaveBeenCalledTimes(1);
});

it("relays the organization-owned device DTO and refuses an implicit admin organization", async () => {
  const seen: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(part);
    seen.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const body = request();
    const service = new ResourceBackendService({} as never, {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: "owned-fixture-token",
    });
    await service.registerDevice(body);
    expect(seen).toEqual([body]);
    expect(() => service.registerDevice(body.device)).toThrow("organization");
    expect(() => service.registerDevice({ ...body, tenantId: "missing" })).toThrow("organization");
    expect(seen).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("registers for the selected tenant and refuses to transfer an existing device on retry", async () => {
  const db = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 2,
  });
  try {
    await runMigrations(db, "up");
    const first = await createPrivateTenant(db, {
      slug: randomUUID(),
      ownerDisplayName: "Device owner",
    });
    const second = await createPrivateTenant(db, {
      slug: randomUUID(),
      ownerDisplayName: "Another owner",
    });
    const { device } = request();
    const transport = {
      inspect: async () => ({
        targetId: device.targetId,
        bootId: "owned-boot",
        ready: true,
        capabilities: [...ANDROID_CAPABILITIES],
      }),
    };
    await registerResourceDevice(db, transport, first.tenantId, device);
    await registerResourceDevice(db, transport, first.tenantId, device);
    await expect(registerResourceDevice(db, transport, second.tenantId, device)).rejects.toThrow(
      "different identity",
    );
    const { rows } = await sql<{ tenant_id: string }>`select tenant_id from execution_targets
      where id=${device.targetId}::uuid`.execute(db);
    expect(rows[0]?.tenant_id).toBe(first.tenantId);
  } finally {
    await db.destroy();
  }
});
