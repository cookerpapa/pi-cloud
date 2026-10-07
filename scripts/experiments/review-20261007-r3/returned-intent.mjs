import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { ComposerSubmission } from "../../../packages/web-ui/src/composer-submission.ts";
import { PiCloudApi } from "../../../packages/web-ui/src/api.ts";
import {
  inputReturnRecovery,
  restoreReturnedInputs,
} from "../../../packages/web-ui/src/returned-inputs.ts";
const cases = [];
for (const invalidateStoppedIntent of [false, true]) {
  const submission = new ComposerSubmission(),
    sessionId = randomUUID(),
    turnId = randomUUID(),
    requestId = randomUUID();
  const input = { kind: "turn", sessionId, text: "queued X", uploadIds: [] };
  const calls = [];
  const records = new Map();
  let dropReply = true,
    available = true;
  const api = new PiCloudApi(async (url, init) => {
    if (String(url).endsWith("/turns")) {
      const key = new Headers(init.headers).get("idempotency-key");
      calls.push(key);
      let record = records.get(key),
        replayed = !!record;
      if (!record) {
        record = {
          runId: randomUUID(),
          turnId: records.size ? randomUUID() : turnId,
          runState: "queued",
          acceptedAt: new Date().toISOString(),
          mailboxPosition: records.size + 2,
        };
        records.set(key, record);
      }
      if (dropReply) {
        dropReply = false;
        throw Error("Owned lost acceptance response");
      }
      return Response.json(
        {
          runId: record.runId,
          turnId: record.turnId,
          sessionId,
          state: "queued",
          mailboxPosition: record.mailboxPosition,
          acceptedAt: record.acceptedAt,
          replayed,
        },
        { status: 202 },
      );
    }
    if (String(url).endsWith("/acknowledgements")) {
      available = false;
      return new Response(null, { status: 204 });
    }
    if (String(url).includes("/returned-inputs"))
      return Response.json({
        sessionId,
        requestId: available ? requestId : null,
        afterPosition: 0,
        pending: false,
        hasMore: false,
        items: available ? [{ turnId, text: input.text, uploads: [], mailboxPosition: 2 }] : [],
      });
    throw Error("Unexpected fixture request");
  });
  const send = (key) => api.acceptTurn(sessionId, input.text, key, undefined, []);
  await assert.rejects(submission.send(input, send));
  // Clearing the draft and restoring a stopped input do not reset the shared
  // pending identity in ChatApp. Model the server's cancelled original Run;
  // its idempotent acceptance DTO still describes the original admission.
  let draft = "";
  for (const record of records.values()) record.runState = "cancelled";
  if (invalidateStoppedIntent) submission.reset();
  await restoreReturnedInputs(
    api,
    sessionId,
    inputReturnRecovery(),
    (text) => {
      draft = draft.trim() ? draft + "\n\n" + text : text;
    },
    new AbortController().signal,
  );
  assert.equal(draft, input.text);
  const receipt = await submission.send({ ...input, text: draft }, send);
  draft = "";
  cases.push({
    invalidateStoppedIntent,
    requests: calls.length,
    distinctKeys: new Set(calls).size,
    admittedRuns: records.size,
    replayed: receipt.replayed,
    wireState: receipt.state,
    resubmissionRunState: records.get(calls.at(-1)).runState,
    draftAfterSuccess: draft,
  });
}
assert.equal(cases[0].distinctKeys, 1);
assert.equal(cases[0].resubmissionRunState, "cancelled");
assert.equal(cases[1].distinctKeys, 2);
const result = {
  scope:
    "actual ComposerSubmission, PiCloudApi validation and returned-input recovery; controlled durable-admission/reply-loss fixture; ChatApp wiring checked separately",
  controlIsNotAProposedBlindReset: true,
  cases,
};
await writeFile(
  process.argv[2] ?? "/tmp/pi-cloud-returned-intent.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
