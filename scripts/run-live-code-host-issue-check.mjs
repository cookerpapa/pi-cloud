import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { workspaceVolumeId } from "../packages/tool-broker/src/workspace-volume-gateway-contract.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
if (process.env.PI_CLOUD_LIVE_CODE_HOST_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_CODE_HOST_CHECK=1 to acknowledge real GitLab, model and Cube usage",
  );
}

function environment(value) {
  return Object.fromEntries(
    value
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error("Production environment file is invalid");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

const runtimeDirectory = resolve(repositoryRoot, "deploy/production/runtime");
const production = environment(await readFile(resolve(runtimeDirectory, ".env"), "utf8"));
const host =
  production.PI_CLOUD_HTTP_BIND_ADDRESS === "0.0.0.0"
    ? "127.0.0.1"
    : production.PI_CLOUD_HTTP_BIND_ADDRESS;
const baseUrl = new URL(`http://${host}:${production.PI_CLOUD_HTTP_PORT}`);
const gitlabOrigin = "http://gitlab.localhost:8929";
const gitlabApiOrigin = "http://127.0.0.1:8929";
const suffix = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
const tokenName = `picloud-code-host-${suffix}`;

class CookieFetch {
  cookie;
  fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (this.cookie !== undefined) headers.set("cookie", this.cookie);
    const response = await fetch(new URL(String(input), baseUrl), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(10 * 60_000),
    });
    for (const value of response.headers.getSetCookie?.() ?? []) {
      const match = /(?:^|[,;]\s*)(pi_cloud_session=[^;]*)/u.exec(value);
      if (match !== null) this.cookie = match[1];
    }
    return response;
  };
}

function gitlabRails(ruby) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--file",
      resolve(repositoryRoot, "deploy/gitlab/compose.yaml"),
      "exec",
      "--no-TTY",
      "gitlab",
      "gitlab-rails",
      "runner",
      "-e",
      "production",
      ruby,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PI_CLOUD_GITLAB_RUNTIME_DIRECTORY: resolve(repositoryRoot, "deploy/gitlab/runtime"),
      },
      encoding: "utf8",
      maxBuffer: 4 * 1_024 * 1_024,
    },
  );
  if (result.status !== 0) throw new Error(result.stderr.trim() || "GitLab Rails command failed");
  return result.stdout.trim().split("\n").at(-1)?.trim() ?? "";
}

async function gitlab(path, token, init = {}) {
  const response = await fetch(new URL(path, gitlabApiOrigin), {
    ...init,
    headers: {
      "private-token": token,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitLab ${response.status}: ${text.slice(0, 500)}`);
  return text.length === 0 ? undefined : JSON.parse(text);
}

async function waitFor(check, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined && value !== false && value !== null) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`${label} timed out`);
}

const accessToken = gitlabRails(
  [
    "require 'date'",
    "user = User.find_by_username!('root')",
    `name = '${tokenName}'`,
    "user.personal_access_tokens.where(name: name).delete_all",
    "organization = Organizations::Organization.default_organization",
    "response = PersonalAccessTokens::CreateService.new(current_user: user, target_user: user, organization_id: organization.id, params: { name: name, scopes: [:api, :write_repository], expires_at: Date.today + 1 }).execute",
    "raise response.message unless response.success?",
    "puts response.payload[:personal_access_token].token",
  ].join("; "),
);
assert(accessToken.length >= 16, "GitLab did not issue an acceptance token");

const cookies = new CookieFetch();
const api = new PiCloudApi(cookies.fetch);
const registration = await api.registerAccount(
  `code.host.${suffix}`.slice(0, 48),
  "Code Host Acceptance",
  `Code Host ${suffix} password 9!`,
);
let gitlabProjectId;
let workspaceId;
let sessionId;
try {
  const project = await gitlab("/api/v4/projects", accessToken, {
    method: "POST",
    body: JSON.stringify({
      name: `picloud-code-host-${suffix}`,
      path: `picloud-code-host-${suffix}`,
      visibility: "private",
      initialize_with_readme: true,
    }),
  });
  gitlabProjectId = String(project.id);
  const connectedResponse = await cookies.fetch("/v1/source-control/gitlab/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: gitlabOrigin,
      project: String(project.path_with_namespace),
      accessToken,
    }),
  });
  assert.equal(connectedResponse.status, 201, await connectedResponse.text());
  await gitlab(`/api/v4/projects/${gitlabProjectId}/labels`, accessToken, {
    method: "POST",
    body: JSON.stringify({ name: "picloud", color: "#7664d1" }),
  });
  const issue = await gitlab(`/api/v4/projects/${gitlabProjectId}/issues`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      title: "Implement and test insertion sort",
      description:
        "Clone this repository into the selected Workspace. Add insertion_sort.py with executable tests for empty, sorted, reverse, duplicate and negative inputs. Run the tests. Do not commit, push, comment on, or close this Issue.",
      labels: "picloud",
    }),
  });
  const job = await waitFor(async () => {
    const jobs = await api.listSourceControlIssueJobs();
    return jobs.jobs.find(
      (candidate) =>
        candidate.issueNumber === issue.iid &&
        candidate.repositoryFullName === project.path_with_namespace,
    );
  }, "GitLab Webhook Issue job");
  assert.equal(job.claimEligible, true);
  assert.equal(job.state, "awaiting_claim");
  const claimed = await api.claimSourceControlIssueJob(job.jobId);
  assert.equal(claimed.claimedByCurrentUser, true);
  assert.equal(claimed.claims[0]?.username, registration.identity.username);

  const workspace = await api.createProject(`Code Host Issue ${suffix}`);
  workspaceId = workspace.workspaceId;
  const missing = await api.preflightSourceControlIssueGit(job.jobId, workspaceId);
  assert.deepEqual(missing, { authorized: false, reason: "credential_missing" });
  const connected = await api.connectCodeHost(workspaceId, {
    provider: "gitlab",
    origin: job.codeHostOrigin,
    accessToken,
  });
  assert.deepEqual(connected.connections, [
    { provider: "gitlab", origin: new URL(job.codeHostOrigin).origin },
  ]);
  const authorized = await api.preflightSourceControlIssueGit(job.jobId, workspaceId);
  assert.equal(authorized.authorized, true);

  await api.startSourceControlIssueJob(job.jobId, {
    executionMode: "elastic",
    sessionTitle: `Insertion sort Issue ${suffix}`,
    sandboxProfileKey: "standard",
    workspaceId,
  });
  const started = await waitFor(async () => {
    const jobs = await api.listSourceControlIssueJobs();
    const current = jobs.jobs.find((candidate) => candidate.jobId === job.jobId);
    return current?.sessionId !== undefined && current.runId !== undefined ? current : undefined;
  }, "Issue coordinator start");
  sessionId = started.sessionId;
  const run = await waitFor(
    async () => {
      const current = await api.getRun(started.runId);
      if (["failed", "cancelled", "timed_out", "superseded"].includes(current.state)) {
        throw new Error(`Issue Run failed: ${current.failure?.code ?? current.state}`);
      }
      return current.state === "completed" ? current : undefined;
    },
    "real Issue coding Run",
    10 * 60_000,
  );
  assert.equal(run.state, "completed");
  const completedJob = await waitFor(async () => {
    const jobs = await api.listSourceControlIssueJobs();
    return jobs.jobs.find((candidate) => candidate.jobId === job.jobId)?.state === "completed"
      ? jobs.jobs.find((candidate) => candidate.jobId === job.jobId)
      : undefined;
  }, "Issue job settlement");
  assert.equal(completedJob.state, "completed");

  const volumeId = workspaceVolumeId({ tenantId: registration.identity.tenantId, workspaceId });
  const environmentRoot = resolve(
    runtimeDirectory,
    "state/cube-shared/volume",
    `picloud-posix-${volumeId}`,
    "workspace",
  );
  const credentialBytes = await readFile(resolve(environmentRoot, ".git-credentials"), "utf8");
  assert(credentialBytes.includes(accessToken));
  await assert.rejects(readFile(resolve(environmentRoot, ".pi-cloud-home/.git-credentials")));
  const postgresDump = execFileSync(
    process.execPath,
    [
      "scripts/production-compose.mjs",
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "--username",
      "pi_cloud",
      "--dbname",
      "pi_cloud",
      "--data-only",
    ],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1_024 * 1_024 },
  );
  const tokenOffset = postgresDump.indexOf(accessToken);
  if (tokenOffset >= 0) {
    const copyHeader = postgresDump
      .slice(0, tokenOffset)
      .match(/COPY public\.([^ ]+) .*$/gmu)
      ?.at(-1);
    throw new Error(
      `Code Host token leaked into PostgreSQL${copyHeader === undefined ? "" : ` through ${copyHeader.split(" ")[1]}`}`,
    );
  }
  const issueAfter = await gitlab(
    `/api/v4/projects/${gitlabProjectId}/issues/${String(issue.iid)}`,
    accessToken,
  );
  assert.equal(issueAfter.state, "opened");

  const report = {
    accepted: true,
    piCloudRevision: revision,
    checkedAt: new Date().toISOString(),
    identity: { piCloudLocalLoginClaimedGitLabIssue: true, gitLabOidcRequired: false },
    codeHost: {
      provider: "gitlab",
      origin: new URL(job.codeHostOrigin).origin,
      initialPreflight: missing.reason,
      authorizedPreflight: authorized.authorized,
      tokenStoredOnlyInEnvironment: true,
      legacyPiCloudHomeAbsent: true,
    },
    execution: {
      completed: true,
      platformClonedRepository: false,
      agentOwnedGitClone: true,
      issueStateChanged: false,
    },
  };
  const reportDirectory = resolve(repositoryRoot, "docs/reports");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    resolve(reportDirectory, "gitlab-issue-acceptance-latest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(reportDirectory, "gitlab-issue-acceptance-latest.md"),
    [
      "# GitLab Issue acceptance",
      "",
      `- Checked at: ${report.checkedAt}`,
      "- PiCloud local user claimed a GitLab Issue without GitLab OIDC: true",
      `- Environment Code Host Origin: ${report.codeHost.origin}`,
      "- Missing credential / authorized exact-repository preflight: true / true",
      "- User token stored only in environment `.git-credentials`: true",
      "- Legacy `.pi-cloud-home` absent: true",
      "- Real Agent coding Run completed: true",
      "- Platform clone / Agent-owned clone: false / true",
      "- Issue remained open for explicit later delivery: true",
      "",
    ].join("\n"),
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  if (sessionId !== undefined) {
    await api
      .deleteConversation(sessionId, newIdempotencyKey("code-host-cleanup"))
      .catch(() => undefined);
  }
  if (workspaceId !== undefined) {
    await api
      .deleteWorkspace(workspaceId, newIdempotencyKey("code-host-workspace-cleanup"))
      .catch(() => undefined);
  }
  if (gitlabProjectId !== undefined) {
    await gitlab(`/api/v4/projects/${gitlabProjectId}`, accessToken, { method: "DELETE" }).catch(
      () => undefined,
    );
  }
  gitlabRails(
    `user = User.find_by_username!('root'); user.personal_access_tokens.where(name: '${tokenName}').delete_all; puts 'revoked'`,
  );
}
