import { describe, expect, it } from "vitest";
import { consumePartitioned } from "../src/partitioned-consumption.ts";

describe("bounded partition consumption", () => {
  it("allows another partition to finish without overtaking a blocked partition", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let otherDone!: () => void;
    const observed = new Promise<void>((resolve) => {
      otherDone = resolve;
    });
    const order: string[] = [];
    async function* messages() {
      yield { partition: 0, id: "A1" };
      yield { partition: 0, id: "A2" };
      yield { partition: 1, id: "B1" };
    }
    const running = consumePartitioned(messages(), async (message) => {
      if (message.id === "A1") await blocked;
      order.push(message.id);
      if (message.id === "B1") otherDone();
    });
    await observed;
    expect(order).toEqual(["B1"]);
    release();
    await running;
    expect(order).toEqual(["B1", "A1", "A2"]);
  });

  it("bounds pending work and does not execute queued successors after failure", async () => {
    let active = 0,
      maximum = 0;
    async function* messages() {
      for (let i = 0; i < 50; i++) yield { partition: i, id: i };
    }
    await consumePartitioned(
      messages(),
      async () => {
        maximum = Math.max(maximum, ++active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
      },
      4,
    );
    expect(maximum).toBeLessThanOrEqual(4);
    const seen: number[] = [];
    await expect(
      consumePartitioned(
        messages(),
        async ({ id }) => {
          seen.push(id);
          throw new Error("failed");
        },
        1,
      ),
    ).rejects.toThrow("failed");
    expect(seen).toEqual([0]);
  });
});
