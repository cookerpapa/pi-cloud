import { describe, expect, it } from "vitest";
import { closeControlPlaneResources } from "../src/main.ts";

describe("Control Plane resource shutdown", () => {
  it("drains every resource in dependency order and reports all close failures", async () => {
    const visited: string[] = [];
    const httpFailure = new Error("http close failed");
    const logFailure = new Error("log close failed");
    const result = closeControlPlaneResources([
      async () => {
        visited.push("coordinator");
      },
      async () => {
        visited.push("http");
        throw httpFailure;
      },
      () => {
        visited.push("projector");
        throw logFailure;
      },
      async () => {
        visited.push("database");
      },
      async () => {
        visited.push("metrics");
      },
    ]);
    await expect.soft(result).rejects.toMatchObject({ errors: [httpFailure, logFailure] });
    expect(visited).toEqual(["coordinator", "http", "projector", "database", "metrics"]);
  });

  it("allows unstarted resources without skipping initialized ones", async () => {
    let closed = false;
    await closeControlPlaneResources([
      () => undefined,
      async () => {
        closed = true;
      },
    ]);
    expect(closed).toBe(true);
  });
});
