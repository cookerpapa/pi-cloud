import { describe, expect, it, vi } from "vitest";
import type { ToolSandboxAssignment } from "@pi-cloud/protocol";
import { SandboxAdmission } from "../src/sandbox-admission.ts";

// Admission treats assignment metadata as an opaque owner tag, not authority.
const assignment = { sessionId: "session" } as ToolSandboxAssignment;

describe("Broker physical Sandbox admission", () => {
  it("releases one FIFO waiter without reserving capacity for an aborted request", async () => {
    const capacity = new SandboxAdmission(1, async () => false);
    await capacity.acquire("a", assignment);
    const aborted = new AbortController();
    const b = capacity.acquire("b", assignment, aborted.signal).catch((error) => error);
    const c = capacity.acquire("c", assignment);
    await vi.waitFor(() => expect(capacity.waitingCount).toBe(2));
    aborted.abort();
    expect(await b).toMatchObject({ code: "tool_binding_admission_cancelled" });
    capacity.release("a");
    await c;
    expect([...capacity.entries()].map(([id]) => id)).toEqual(["c"]);
    capacity.release("a");
    expect(capacity.size).toBe(1);
    capacity.close();
  });

  it("does not wake queued creates while shutting down and releasing running machines", async () => {
    const capacity = new SandboxAdmission(1, async () => false);
    await capacity.acquire("a", assignment);
    const b = capacity.acquire("b", assignment).catch((error) => error);
    await vi.waitFor(() => expect(capacity.waitingCount).toBe(1));
    capacity.close();
    capacity.release("a");
    expect(await b).toMatchObject({ code: "tool_binding_admission_closed" });
    expect(capacity.size).toBe(0);
    expect(capacity.waitingCount).toBe(0);
    await expect(capacity.acquire("c", assignment)).rejects.toMatchObject({
      code: "tool_binding_admission_closed",
    });
  });

  it("rechecks closure after asynchronous warm eviction, without allocating another VM", async () => {
    let evicted!: (value: boolean) => void;
    const capacity = new SandboxAdmission(
      1,
      () =>
        new Promise((resolve) => {
          evicted = resolve;
        }),
    );
    capacity.restore("warm", assignment);
    const pending = capacity.acquire("new", assignment).catch((error) => error);
    capacity.close();
    evicted(true);
    expect(await pending).toMatchObject({ code: "tool_binding_admission_closed" });
    expect(capacity.size).toBe(0);
  });

  it("accounts for adopted machines above a lowered limit before admitting new work", async () => {
    const capacity = new SandboxAdmission(1, async () => false);
    capacity.restore("old-a", assignment);
    capacity.restore("old-b", assignment);
    const newWork = capacity.acquire("new", assignment);
    await vi.waitFor(() => expect(capacity.waitingCount).toBe(1));
    capacity.release("old-a");
    expect(capacity.waitingCount).toBe(1);
    expect(capacity.has("new")).toBe(false);
    capacity.release("old-b");
    await newWork;
    expect(capacity.size).toBe(1);
    capacity.close();
  });

  it("transfers a counted runtime without allocating or releasing a physical slot", async () => {
    const capacity = new SandboxAdmission(1, async () => false);
    capacity.restore("terminal", assignment);
    capacity.transfer("terminal", "binding", assignment);
    expect(capacity.has("terminal")).toBe(false);
    expect(capacity.has("binding")).toBe(true);
    expect(capacity.size).toBe(1);
    capacity.close();
  });

  it("accounts for an in-flight adoption finishing during shutdown without reopening admission", async () => {
    const capacity = new SandboxAdmission(1, async () => false);
    capacity.close();
    capacity.restore("already-running", assignment);
    expect(capacity.size).toBe(1);
    await expect(capacity.acquire("new", assignment)).rejects.toMatchObject({
      code: "tool_binding_admission_closed",
    });
    capacity.release("already-running");
    expect(capacity.size).toBe(0);
  });
});
