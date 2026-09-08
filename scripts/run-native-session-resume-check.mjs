import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import WebSocket from "ws";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

if (process.env.PI_CLOUD_LIVE_NATIVE_RESUME_CHECK !== "1")
  throw new Error("Opt in to real model/Cube resume acceptance");
const sessionId = process.env.PI_CLOUD_NATIVE_RESUME_SESSION;
assert.match(sessionId ?? "", /^[a-f0-9-]{36}$/);
const exec = promisify(execFile),
  base = process.env.PI_CLOUD_NATIVE_ACCEPTANCE_URL ?? "http://127.0.0.1:8080";
const capture = async (args) =>
  (await exec("docker", args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
async function query(sql) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      [
        "exec",
        "-i",
        "pi-cloud-production-postgres-1",
        "sh",
        "-c",
        'exec psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
      ],
      { maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
    child.stdin.end(sql);
  });
}
const meta = JSON.parse(
  await query(`select json_build_object('tenantId',s.tenant_id,'userId',s.created_by_user_id,'tenantSlug',t.slug,'title',s.title,
  'workspaceId',s.workspace_id,'marker',(select (regexp_match(input_text,'ALGO-LAB-[A-Z0-9-]+'))[1] from turns where session_id=s.id order by created_at limit 1))
  from sessions s join tenants t on t.id=s.tenant_id where s.id='${sessionId}'`),
);
assert(
  meta.tenantSlug.startsWith("long-context-") &&
    meta.title.startsWith("Long-context algorithm lab"),
  "Only an explicitly selected acceptance Session may be used",
);
assert(meta.marker);
const issued = JSON.parse(
  await capture([
    "exec",
    "pi-cloud-production-control-plane-1",
    "node",
    "/app/packages/control-plane/src/tenant-admin.ts",
    "issue",
    "--tenant",
    meta.tenantSlug,
    "--user-id",
    meta.userId,
    "--label",
    "native-resume-check",
    "--role",
    "owner",
  ]),
);
const token = issued.credential.token;
const fetchApi = (url, init) => fetch(new URL(String(url), base), init),
  api = new PiCloudApi(fetchApi, token);
const report = {
  format: "pi-cloud.native-session-resume.v1",
  checkedAt: new Date().toISOString(),
  sessionId,
  rounds: [],
  accepted: false,
};
let stopped;
const compose = async (...args) => {
  if (args[0] === "start") args = ["up", "-d", "--no-deps", "--wait", ...args.slice(1)];
  await exec(process.execPath, ["scripts/production-compose.mjs", ...args], {
    timeout: 180000,
    maxBuffer: 2 * 1024 * 1024,
  });
};
async function round(prompt, tools) {
  const began = performance.now(),
    accepted = await api.acceptTurn(sessionId, prompt, newIdempotencyKey("native-resume"));
  const abort = new AbortController(),
    events = [],
    seen = new Set();
  let terminal, firstVisible;
  const timer = setTimeout(() => abort.abort(new Error("Acceptance Run timed out")), 600000);
  const observe = (e) => {
    if (e.turnId !== accepted.turnId || seen.has(e.eventId)) return;
    seen.add(e.eventId);
    events.push(e);
    if (
      [
        "assistant.text.delta",
        "assistant.tool_call.preparing",
        "tool.started",
        "provider.hosted_tool.started",
      ].includes(e.type)
    )
      firstVisible ??= performance.now();
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(e.type)) {
      terminal = e.type;
      abort.abort();
    }
  };
  try {
    await streamSessionEvents({
      sessionId,
      signal: abort.signal,
      authorizationToken: token,
      fetchImplementation: fetchApi,
      retryDelayMs: 100,
      onStatus() {},
      onEvent: observe,
      onSnapshot: (s) => {
        for (const event of s.liveEvents) observe(event);
        const turn = s.conversation.turns.find((t) => t.turnId === accepted.turnId);
        if (turn?.transcript && ["completed", "failed", "cancelled"].includes(turn.state)) {
          terminal = `turn.${turn.state}`;
          abort.abort();
        }
      },
    });
    assert.equal(terminal, "turn.completed", JSON.stringify(events.at(-1)));
    const conversation = await api.getConversation(sessionId),
      turn = conversation.turns.find((t) => t.turnId === accepted.turnId);
    assert(turn?.transcript, "A public terminal must expose its canonical transcript");
    const text = turn.transcript.items
      .filter((i) => i.kind === "text")
      .map((i) => i.text)
      .join("");
    const toolCalls = events.filter((e) => e.type === "tool.started").length;
    if (tools) assert(toolCalls > 0);
    const worker = await query(
      `select s.supervisor_id from run_attempts a join sandboxes s on s.id=a.sandbox_id where a.run_id='${accepted.runId}' order by a.attempt_number desc limit 1`,
    );
    report.rounds.push({
      runId: accepted.runId,
      turnId: accepted.turnId,
      worker,
      toolCalls,
      hostedSearches: events.filter((e) => e.type === "provider.hosted_tool.started").length,
      firstVisibleMs: firstVisible === undefined ? null : Math.round(firstVisible - began),
      elapsedMs: Math.round(performance.now() - began),
    });
    console.log(
      `[native-resume] ${report.rounds.length}: ${worker}, tools=${toolCalls}, completed`,
    );
    return { text, worker };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}
async function terminalCheck() {
  const target = new URL(`/v1/conversations/${sessionId}/terminal`, base);
  target.protocol = "ws:";
  const command =
    "python3 -m unittest discover -s tests; rc=$?; printf '\\nNATIVE_CHECK_EXIT_%s\\n' \"$rc\"";
  const shell = `printf '%s' '${Buffer.from(command).toString("base64")}' | base64 -d | bash\n`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target, { headers: { authorization: `Bearer ${token}` } });
    let output = "",
      result;
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Terminal verification timeout"));
    }, 120000);
    socket.on("message", (raw) => {
      const e = JSON.parse(raw.toString());
      if (e.type === "workspace_terminal.ready")
        socket.send(
          JSON.stringify({
            workspaceTerminalProtocolVersion: 1,
            type: "workspace_terminal.input",
            data: Buffer.from(shell).toString("base64"),
          }),
        );
      else if (e.type === "workspace_terminal.output") {
        output = (output + Buffer.from(e.data, "base64").toString()).slice(-262144);
        const match = output.match(/NATIVE_CHECK_EXIT_(\d+)/);
        if (match) {
          result = { exitCode: Number(match[1]), summary: output.slice(-7000) };
          socket.send(
            JSON.stringify({
              workspaceTerminalProtocolVersion: 1,
              type: "workspace_terminal.close",
            }),
          );
        }
      } else if (e.type === "workspace_terminal.error") {
        socket.terminate();
        reject(new Error(e.code));
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      result ? resolve(result) : reject(new Error("Terminal closed without a verification result"));
    });
  });
}
try {
  const compactions = JSON.parse(
    await query(
      `select json_agg(json_build_object('seq',seq,'tokensBefore',payload->'tokensBefore')) from pi_session_entries where session_id='${sessionId}' and type='compaction'`,
    ),
  );
  assert(compactions.length >= 2);
  report.compactions = compactions;
  await api.updateSessionModel(sessionId, {
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "off",
    fastMode: false,
  });
  const recall = await round(
    "Do not use any tools. Return only the exact ALGO-LAB project invariant marker given in the first coding turn.",
    false,
  );
  assert(recall.text.includes(meta.marker));
  report.recallPassed = true;
  const coded = await round(
    "Continue the existing algolab project after the interruption. Inspect the actual APIs and run python3 -m unittest discover -s tests. Fix any failures without removing tests. Add tests/test_native_resume_validation.py that verifies stable binary insertion sort against the existing implementation, including equal-key records and 100 seeded randomized inputs. Run the complete suite and report its result briefly. Do not use subagents.",
    true,
  );
  stopped = coded.worker.endsWith("-1") ? "supervisor-host" : "supervisor-host-1";
  await compose("stop", stopped);
  const migrated = await round(
    "Use tools to continue the same project on this Worker. Read tests/test_native_resume_validation.py, add a deterministic regression for empty and singleton inputs through the actual existing API, and run python3 -m unittest discover -s tests. Do not remove tests or use subagents.",
    true,
  );
  assert.notEqual(migrated.worker, coded.worker);
  report.crossWorkerPassed = true;
  await compose("start", stopped);
  stopped = undefined;
  let checked = await terminalCheck();
  for (let attempt = 0; checked.exitCode !== 0 && attempt < 2; attempt++) {
    await round(
      `An independent terminal verification failed. Fix the actual errors without deleting tests, then rerun the full suite. Diagnostic:\n${checked.summary}`,
      true,
    );
    checked = await terminalCheck();
  }
  assert.equal(checked.exitCode, 0);
  report.independentTests = {
    exitCode: 0,
    ...(/Ran (\d+) tests?/.test(checked.summary)
      ? { tests: Number(checked.summary.match(/Ran (\d+) tests?/)[1]) }
      : {}),
  };
  await api.updateSessionModel(sessionId, {
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
    thinkingLevel: "medium",
    fastMode: true,
  });
  const searched = await round(
    "Use only Provider-hosted web search, no Pi function tools. Find the title of the official Python unittest documentation page. Reply with that title and the original ALGO-LAB project marker from history.",
    false,
  );
  assert(searched.text.includes(meta.marker));
  assert(report.rounds.at(-1).hostedSearches > 0);
  report.providerSwitchPassed = true;
  report.usage = JSON.parse(
    await query(`select json_build_object('input',sum(coalesce((u->>'input')::bigint,0)),'output',sum(coalesce((u->>'output')::bigint,0)),
    'cacheRead',sum(coalesce((u->>'cacheRead')::bigint,0)),'cacheWrite',sum(coalesce((u->>'cacheWrite')::bigint,0))) from
    (select coalesce(payload#>'{message,usage}',payload->'usage') u from pi_session_entries where session_id='${sessionId}') s where u is not null`),
  );
  report.accepted = true;
} finally {
  if (stopped) await compose("start", stopped);
  await writeFile(
    "docs/reports/native-session-resume-acceptance-latest.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  const credentialId = issued.credential.credentialId ?? token.slice(4, token.indexOf("."));
  await capture([
    "exec",
    "pi-cloud-production-control-plane-1",
    "node",
    "/app/packages/control-plane/src/tenant-admin.ts",
    "revoke",
    "--tenant",
    meta.tenantSlug,
    "--credential-id",
    credentialId,
  ]).catch(() => {});
  console.log(JSON.stringify(report));
}
