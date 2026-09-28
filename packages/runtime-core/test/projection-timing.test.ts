import { PiCloudMetrics } from "@pi-cloud/observability";
import { expect, it, vi } from "vitest";
import { ProjectionTiming } from "../src/projection-timing.ts";
import type { KafkaAcceptedFactRecord } from "../src/kafka-accepted-fact-consumer.ts";

it("reports the blocked phase and SQLSTATE without logging record bodies or errors", async () => {
  const record = {
    topic: "test",
    partition: 2,
    offset: 19n,
    fact: {
      kind: "pi_session_append",
      scope: { runId: "run", piSessionId: "session" },
      items: [{ content: "private body" }],
    },
  } as unknown as KafkaAcceptedFactRecord;
  const metrics = new PiCloudMetrics("projection-test");
  const output: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((line) => {
    output.push(String(line));
    return true;
  });
  const timer = new ProjectionTiming(metrics);
  const error = Object.assign(new Error("private SQL parameters"), { code: "55P03" });
  try {
    await expect(
      timer.measure("projection", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    timer.finish(record, error);
  } finally {
    write.mockRestore();
  }
  expect(output).toHaveLength(1);
  expect(JSON.parse(output[0]!).attributes).toMatchObject({
    partition: 2,
    offset: "19",
    failedStage: "projection",
    errorCode: "55P03",
  });
  expect(output[0]).not.toContain("private");
  const rendered = await metrics.registry.metrics();
  expect(rendered).toContain('stage="projection",outcome="error"');
  expect(rendered).not.toContain("runId");
  const broken = vi.spyOn(metrics.sessionProjectionDuration, "observe").mockImplementation(() => {
    throw new Error("observer failure");
  });
  try {
    await expect(new ProjectionTiming(metrics).measure("tool_route", async () => 7)).resolves.toBe(
      7,
    );
  } finally {
    broken.mockRestore();
  }
});
