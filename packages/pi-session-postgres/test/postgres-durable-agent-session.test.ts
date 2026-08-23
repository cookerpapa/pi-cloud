import { describe, expect, it } from "vitest";
import { synchronizePiSessionProjectionBeforeRead } from "../src/postgres-durable-agent-session.ts";

describe("durable Agent Session recovery barrier", () => {
  it("waits for older Session mutations before rechecking the new fence", async () => {
    const order: string[] = [];

    await synchronizePiSessionProjectionBeforeRead(
      {
        async mutate() {
          throw new Error("The recovery barrier does not append a Pi mutation directly");
        },
        async synchronize() {
          order.push("projection-barrier");
        },
      },
      {
        async assertCurrent() {
          order.push("authority-recheck");
        },
      },
    );

    expect(order).toEqual(["projection-barrier", "authority-recheck"]);
  });

  it("still checks authority when the direct PostgreSQL adapter has no Kafka publisher", async () => {
    let checks = 0;
    await synchronizePiSessionProjectionBeforeRead(undefined, {
      async assertCurrent() {
        checks += 1;
      },
    });
    expect(checks).toBe(1);
  });
});
