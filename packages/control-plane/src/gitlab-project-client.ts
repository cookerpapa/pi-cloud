import { createHmac, timingSafeEqual } from "node:crypto";

const MAXIMUM_RESPONSE_BYTES = 4 * 1_024 * 1_024;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type GitLabProject = Readonly<{
  id: string;
  namespaceId: string;
  namespace: string;
  namespaceKind: "User" | "Organization";
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  webUrl: string;
}>;

export class GitLabProjectClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "GitLabProjectClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitLabProjectClientError(
      "gitlab_response_invalid",
      "GitLab returned invalid data",
      false,
    );
  }
  return value as Record<string, unknown>;
}

function decimalId(value: unknown, label: string): string {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9][0-9]{0,30}$/.test(text)) {
    throw new GitLabProjectClientError("gitlab_response_invalid", `${label} was invalid`, false);
  }
  return text;
}

function bounded(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new GitLabProjectClientError("gitlab_response_invalid", `${label} was invalid`, false);
  }
  return value;
}

export function canonicalGitLabBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitLabProjectClientError(
      "gitlab_url_invalid",
      "GitLab instance URL is invalid",
      false,
    );
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new GitLabProjectClientError(
      "gitlab_url_invalid",
      "GitLab instance URL is invalid",
      false,
    );
  }
  return url.origin;
}

async function responseJson(response: Response): Promise<unknown> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAXIMUM_RESPONSE_BYTES) {
    throw new GitLabProjectClientError(
      "gitlab_response_invalid",
      "GitLab response exceeded its byte limit",
      false,
    );
  }
  if (!response.ok) {
    throw new GitLabProjectClientError(
      response.status === 401 || response.status === 403
        ? "gitlab_authorization_failed"
        : response.status === 404
          ? "gitlab_resource_not_found"
          : "gitlab_request_failed",
      "GitLab request failed",
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }
  try {
    return bytes.byteLength === 0 ? {} : (JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    throw new GitLabProjectClientError(
      "gitlab_response_invalid",
      "GitLab returned invalid JSON",
      false,
    );
  }
}

function parseProject(value: unknown, baseUrl: string): GitLabProject {
  const project = record(value);
  const namespace = record(project.namespace);
  const namespaceKind = namespace.kind === "user" ? "User" : "Organization";
  const fullName = bounded(project.path_with_namespace, "GitLab project path", 511);
  const name = bounded(project.path, "GitLab project name", 255);
  const namespaceName = fullName.slice(0, -(name.length + 1));
  const cloneUrl = bounded(project.http_url_to_repo, "GitLab clone URL", 2_048);
  const clone = new URL(cloneUrl);
  if (
    namespaceName.length < 1 ||
    clone.origin !== baseUrl ||
    clone.username ||
    clone.password ||
    !clone.pathname.endsWith(".git")
  ) {
    throw new GitLabProjectClientError(
      "gitlab_response_invalid",
      "GitLab project identity was invalid",
      false,
    );
  }
  const visibility = bounded(project.visibility, "GitLab project visibility", 16);
  return {
    id: decimalId(project.id, "GitLab project ID"),
    namespaceId: decimalId(namespace.id, "GitLab namespace ID"),
    namespace: namespaceName,
    namespaceKind,
    name,
    fullName,
    private: visibility === "private",
    defaultBranch: bounded(project.default_branch, "GitLab default branch", 255),
    cloneUrl,
    webUrl: bounded(project.web_url, "GitLab project URL", 2_048),
  };
}

export class GitLabProjectClient {
  readonly #baseUrl: string;
  readonly #publicBaseUrl: string;
  readonly #apiBaseUrl: URL;
  readonly #accessToken: string;
  readonly #fetch: FetchLike;

  constructor(options: {
    baseUrl: string;
    publicBaseUrl?: string;
    accessToken: string;
    fetch?: FetchLike;
  }) {
    this.#baseUrl = canonicalGitLabBaseUrl(options.baseUrl);
    this.#publicBaseUrl = canonicalGitLabBaseUrl(options.publicBaseUrl ?? options.baseUrl);
    if (
      options.accessToken.length < 16 ||
      options.accessToken.length > 4_096 ||
      /[\r\n\0]/.test(options.accessToken)
    ) {
      throw new TypeError("GitLab project access token is invalid");
    }
    this.#accessToken = options.accessToken;
    this.#apiBaseUrl = new URL("/api/v4/", this.#baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get accessToken(): string {
    return this.#accessToken;
  }

  async project(project: string): Promise<GitLabProject> {
    const reference = bounded(project, "GitLab project", 511);
    return parseProject(
      await this.#request(`projects/${encodeURIComponent(reference)}`),
      this.#publicBaseUrl,
    );
  }

  async ensureWebhook(input: {
    projectId: string;
    url: string;
    signingToken: string;
  }): Promise<string> {
    const hooks = await this.#request(
      `projects/${decimalId(input.projectId, "GitLab project ID")}/hooks`,
    );
    if (!Array.isArray(hooks)) {
      throw new GitLabProjectClientError(
        "gitlab_response_invalid",
        "GitLab hooks were invalid",
        false,
      );
    }
    const existing = hooks.map(record).find((hook) => hook.url === input.url);
    const body = {
      url: input.url,
      name: "PiCloud Issue Agent",
      description: "Create an Agent Run from an explicit Issue label or command",
      issues_events: true,
      note_events: true,
      confidential_issues_events: false,
      confidential_note_events: false,
      enable_ssl_verification: input.url.startsWith("https://"),
      signing_token: input.signingToken,
    };
    const result = record(
      await this.#request(
        existing === undefined
          ? `projects/${input.projectId}/hooks`
          : `projects/${input.projectId}/hooks/${decimalId(existing.id, "GitLab hook ID")}`,
        { method: existing === undefined ? "POST" : "PUT", body: JSON.stringify(body) },
      ),
    );
    return decimalId(result.id, "GitLab hook ID");
  }

  async memberAccessLevel(projectId: string, userId: string): Promise<number | undefined> {
    try {
      const member = record(
        await this.#request(
          `projects/${decimalId(projectId, "GitLab project ID")}/members/all/${decimalId(userId, "GitLab user ID")}`,
        ),
      );
      const level = Number(member.access_level);
      return Number.isSafeInteger(level) ? level : undefined;
    } catch (error: unknown) {
      if (error instanceof GitLabProjectClientError && error.code === "gitlab_resource_not_found") {
        return undefined;
      }
      throw error;
    }
  }

  async createMergeRequest(input: {
    projectId: string;
    title: string;
    description: string;
    sourceBranch: string;
    targetBranch: string;
  }): Promise<{ number: number; url: string }> {
    const value = record(
      await this.#request(`projects/${input.projectId}/merge_requests`, {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          source_branch: input.sourceBranch,
          target_branch: input.targetBranch,
          remove_source_branch: false,
        }),
      }),
    );
    const number = Number(value.iid);
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new GitLabProjectClientError(
        "gitlab_response_invalid",
        "GitLab MR number was invalid",
        false,
      );
    }
    return { number, url: bounded(value.web_url, "GitLab MR URL", 2_048) };
  }

  async findMergeRequest(input: {
    projectId: string;
    sourceBranch: string;
  }): Promise<{ number: number; url: string } | undefined> {
    const values = await this.#request(
      `projects/${input.projectId}/merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(input.sourceBranch)}&per_page=10`,
    );
    if (!Array.isArray(values) || values.length === 0) return undefined;
    const value = record(values[0]);
    const number = Number(value.iid);
    if (!Number.isSafeInteger(number) || number < 1) return undefined;
    return { number, url: bounded(value.web_url, "GitLab MR URL", 2_048) };
  }

  async createIssueNote(input: {
    projectId: string;
    issueNumber: number;
    body: string;
  }): Promise<{ id: string }> {
    const value = record(
      await this.#request(`projects/${input.projectId}/issues/${String(input.issueNumber)}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: input.body }),
      }),
    );
    return { id: decimalId(value.id, "GitLab note ID") };
  }

  async updateIssueNote(input: {
    projectId: string;
    issueNumber: number;
    noteId: string;
    body: string;
  }): Promise<void> {
    await this.#request(
      `projects/${input.projectId}/issues/${String(input.issueNumber)}/notes/${decimalId(input.noteId, "GitLab note ID")}`,
      { method: "PUT", body: JSON.stringify({ body: input.body }) },
    );
  }

  async findIssueNote(input: {
    projectId: string;
    issueNumber: number;
    marker: string;
  }): Promise<{ id: string } | undefined> {
    const values = await this.#request(
      `projects/${input.projectId}/issues/${String(input.issueNumber)}/notes?sort=desc&order_by=created_at&per_page=100`,
    );
    if (!Array.isArray(values)) {
      throw new GitLabProjectClientError(
        "gitlab_response_invalid",
        "GitLab notes were invalid",
        false,
      );
    }
    for (const candidate of values) {
      const note = record(candidate);
      if (typeof note.body === "string" && note.body.includes(input.marker)) {
        return { id: decimalId(note.id, "GitLab note ID") };
      }
    }
    return undefined;
  }

  static verifyWebhook(input: {
    signingToken: string;
    messageId: string | undefined;
    timestamp: string | undefined;
    signature: string | undefined;
    rawBody: Uint8Array;
    now?: number;
  }): boolean {
    if (
      input.messageId === undefined ||
      input.timestamp === undefined ||
      input.signature === undefined ||
      !/^whsec_[A-Za-z0-9+/]{43}=$/.test(input.signingToken) ||
      !/^[0-9]{10,13}$/.test(input.timestamp)
    ) {
      return false;
    }
    const timestamp = Number(input.timestamp);
    const now = Math.floor((input.now ?? Date.now()) / 1_000);
    if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 5 * 60) return false;
    const key = Buffer.from(input.signingToken.slice(6), "base64");
    const message = Buffer.concat([
      Buffer.from(`${input.messageId}.${input.timestamp}.`, "utf8"),
      Buffer.from(input.rawBody),
    ]);
    const expected = `v1,${createHmac("sha256", key).update(message).digest("base64")}`;
    return input.signature.split(" ").some((candidate) => {
      const left = Buffer.from(candidate, "utf8");
      const right = Buffer.from(expected, "utf8");
      return left.length === right.length && timingSafeEqual(left, right);
    });
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#apiBaseUrl), {
        ...init,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "private-token": this.#accessToken,
          ...(init.headers ?? {}),
        },
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
    } catch {
      throw new GitLabProjectClientError("gitlab_unavailable", "GitLab is unavailable", true);
    }
    return responseJson(response);
  }
}
