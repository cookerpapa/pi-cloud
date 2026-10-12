import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { newIdempotencyKey } from "../../packages/web-ui/src/api.ts";
import { crashOwnedWorker } from "./owned-worker-crash.mjs";
import { kubectl, podFor, serviceAddress, signalService } from "./production-kubernetes.mjs";

async function crashBoth(database, tenantId, runId, until) {
  const unrelated = await database
    .selectFrom("runs")
    .select("id")
    .where("tenant_id", "!=", tenantId)
    .where("state", "in", ["queued", "running", "settling", "cancel_requested"])
    .limit(1)
    .execute();
  assert.equal(
    unrelated.length,
    0,
    "Other tenants have unfinished work; refusing Control Plane fault",
  );
  const pod = podFor("control-plane");
  const state = () =>
    JSON.parse(kubectl(["get", "pod", pod, "-o", "json"])).status.containerStatuses.find(
      (container) => container.name === "control-plane",
    );
  const before = state();
  assert(before, "Expected the maintained Control Plane container");
  const paused = signalService("control-plane", "SIGSTOP");
  let worker;
  try {
    // Prevent closure materialization before both processes have lost their memory.
    worker = await crashOwnedWorker(database, tenantId, runId);
    try {
      signalService("control-plane", "SIGKILL", paused);
    } catch {
      /* Kubelet evidence below decides. */
    }
  } finally {
    // A failed injection must not leave the serving process suspended.
    try {
      signalService("control-plane", "SIGCONT", paused);
    } catch {
      /* A killed PID is already absent. */
    }
  }
  const controlPlane = await until(
    async () => {
      const now = state();
      return (
        now.restartCount > before.restartCount &&
        now.lastState?.terminated?.exitCode > 0 && {
          pod,
          exitCode: now.lastState.terminated.exitCode,
          restartCount: now.restartCount,
        }
      );
    },
    "Control Plane crash evidence",
    90000,
  );
  const address = serviceAddress("control-plane");
  await until(async () => {
    try {
      return (
        await fetch(`http://${address}:3000/health/ready`, { signal: AbortSignal.timeout(2000) })
      ).ok;
    } catch {
      return false;
    }
  }, "Control Plane readiness after crash");
  return { worker, controlPlane };
}

/** Owned live fixtures only. Reports contain counts/digests, never model/provider credentials. */
export async function checkNativeLiveProgress({
  database,
  tenantId,
  api,
  createSession,
  until,
  finished,
}) {
  const results = [];
  for (const scenario of ["stream_stop", "stream_both_crash"]) {
    console.log(JSON.stringify({ phase: "native-live", scenario }));
    const session = await createSession(scenario);
    const root = await api.acceptTurn(
      session.sessionId,
      "This is a streaming-output acceptance test. Do not use any tools. In your final answer, directly write 2000 numbered lines. Each line must contain its number and the sentence: LIVE_BUFFER abcdefghijklmnopqrstuvwxyz 0123456789. Do not summarize, explain or use a code block. Keep writing the lines.",
      newIdempotencyKey("live-progress"),
    );
    assert.equal(root.kind, "run");
    const native = await database
      .selectFrom("sessions")
      .select("pi_session_id")
      .where("id", "=", session.sessionId)
      .executeTakeFirstOrThrow();
    const currentRows = async () =>
      (
        await sql`select c.id,c.body,c.replay_seq from pi_durable_current c
      join pi_durable_records r using(tenant_id,session_id,id)
      where c.tenant_id=${tenantId}::uuid and c.session_id=${native.pi_session_id} and r.fields->>'nativeKind'='"pi.live"'`.execute(
          database,
        )
      ).rows;
    const sample = await until(async () => {
      const run = await api.getRun(root.runId);
      assert(
        !["completed", "failed", "cancelled", "timed_out"].includes(run.state),
        "Streaming fixture ended before observation",
      );
      const turn = (await api.getConversation(session.sessionId)).turns.find(
        (t) => t.runId === root.runId,
      );
      assert(
        !turn?.transcript?.items.some((i) => i.kind === "tool"),
        "Streaming fixture unexpectedly used a Tool",
      );
      const text = turn?.transcript?.items.filter((i) => i.kind === "text").at(-1)?.text ?? "";
      const rows = await currentRows();
      return text.length >= 120 && rows.some((row) => row.replay_seq !== null) && { text, rows };
    }, "Confirmed live assistant text");
    for (const row of sample.rows) {
      assert.equal(
        JSON.parse(row.body).content.value.generation,
        undefined,
        "Streaming message must not be in the PG baseline",
      );
      const stored =
        await sql`select 1 from pi_durable_log where tenant_id=${tenantId}::uuid and session_id=${native.pi_session_id} and record_id=${row.id}::bigint
        union all select 1 from pi_durable_document_revisions where tenant_id=${tenantId}::uuid and session_id=${native.pi_session_id} and document_id=${row.id}::bigint`.execute(
          database,
        );
      assert.equal(stored.rows.length, 0, "Live body/revision history must stay out of PG");
    }
    const observed = sample.text.slice(0, 100);
    let crash;
    if (scenario === "stream_both_crash")
      crash = await crashBoth(database, tenantId, root.runId, until);
    else await api.cancelTurn(session.sessionId, root.turnId, newIdempotencyKey("stream-stop"));
    await until(async () => {
      const entries = await sql`select body from pi_durable_log where tenant_id=${tenantId}::uuid
        and session_id=${native.pi_session_id} and record_kind='entry'`.execute(database);
      return entries.rows.some((row) =>
        (JSON.parse(row.body).value.model ?? []).some(
          (message) =>
            message.role === "assistant" &&
            message.stopReason === "aborted" &&
            message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
              .includes(observed),
        ),
      );
    }, "Native interrupted message preserves observed text");
    if (crash) {
      const recovered = await database
        .selectFrom("run_transitions")
        .select("id")
        .where("run_id", "=", root.runId)
        .where("reason", "=", "native_execution_recovery")
        .execute();
      assert(recovered.length > 0, "Expected recovery of the same logical Run");
      await api.cancelTurn(
        session.sessionId,
        root.turnId,
        newIdempotencyKey("recovered-stream-stop"),
      );
    }
    await finished(root.runId);
    assert((await currentRows()).every((row) => row.replay_seq === null));
    const runs = await database
      .selectFrom("runs")
      .select("id")
      .where("session_id", "=", session.sessionId)
      .execute();
    assert.equal(runs.length, 1);
    results.push({
      scenario,
      observedCharacters: sample.text.length,
      observedPrefixSha256: createHash("sha256").update(observed).digest("hex"),
      noPgStreamingBodies: true,
      preservedNativePartial: true,
      oneRun: true,
      ...(crash ? { crash } : {}),
    });
  }
  return results;
}
