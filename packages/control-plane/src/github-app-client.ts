import {
  createHmac,
  createPrivateKey,
  createSign,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

const GITHUB_API_VERSION = "2022-11-28";
const MAXIMUM_RESPONSE_BYTES = 4 * 1_024 * 1_024;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type GitHubAppInstallation = Readonly<{
  id: string;
  account: Readonly<{ id: string; login: string; type: "User" | "Organization" | "Enterprise" }>;
  repositorySelection: "all" | "selected";
  permissions: Readonly<{
    metadata: "read";
    contents: "write";
    issues: "write";
    pullRequests: "write";
  }>;
  suspendedAt?: string;
}>;

export type GitHubRepository = Readonly<{
  id: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}>;

export type GitHubInstallationToken = Readonly<{ token: string; expiresAt: string }>;

export class GitHubAppClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "GitHubAppClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubAppClientError(
      "github_response_invalid",
      "GitHub returned invalid data",
      false,
    );
  }
  return value as Record<string, unknown>;
}

function decimalId(value: unknown, label: string): string {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9][0-9]{0,30}$/.test(text)) {
    throw new GitHubAppClientError("github_response_invalid", `${label} was invalid`, false);
  }
  return text;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new GitHubAppClientError("github_response_invalid", `${label} was invalid`, false);
  }
  return value;
}

function parseInstallation(value: unknown): GitHubAppInstallation {
  const installation = record(value);
  const account = record(installation.account);
  const accountType = account.type;
  if (accountType !== "User" && accountType !== "Organization" && accountType !== "Enterprise") {
    throw new GitHubAppClientError(
      "github_response_invalid",
      "GitHub installation account type was invalid",
      false,
    );
  }
  const selection = installation.repository_selection;
  if (selection !== "all" && selection !== "selected") {
    throw new GitHubAppClientError(
      "github_response_invalid",
      "GitHub repository selection was invalid",
      false,
    );
  }
  const suspendedAt = installation.suspended_at;
  const permissions = record(installation.permissions);
  if (
    permissions.metadata !== "read" ||
    permissions.contents !== "write" ||
    permissions.issues !== "write" ||
    permissions.pull_requests !== "write"
  ) {
    throw new GitHubAppClientError(
      "github_permissions_insufficient",
      "GitHub App installation is missing required repository permissions",
      false,
    );
  }
  if (suspendedAt !== null && suspendedAt !== undefined && typeof suspendedAt !== "string") {
    throw new GitHubAppClientError(
      "github_response_invalid",
      "GitHub installation suspension was invalid",
      false,
    );
  }
  return {
    id: decimalId(installation.id, "GitHub installation ID"),
    account: {
      id: decimalId(account.id, "GitHub account ID"),
      login: boundedString(account.login, "GitHub account login", 255),
      type: accountType,
    },
    repositorySelection: selection,
    permissions: {
      metadata: "read",
      contents: "write",
      issues: "write",
      pullRequests: "write",
    },
    ...(typeof suspendedAt === "string" ? { suspendedAt } : {}),
  };
}

function parseRepository(value: unknown): GitHubRepository {
  const repository = record(value);
  const owner = record(repository.owner);
  const fullName = boundedString(repository.full_name, "GitHub repository name", 511);
  const ownerLogin = boundedString(owner.login, "GitHub repository owner", 255);
  const name = boundedString(repository.name, "GitHub repository name", 255);
  const cloneUrl = boundedString(repository.clone_url, "GitHub clone URL", 2_048);
  if (
    fullName !== `${ownerLogin}/${name}` ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(cloneUrl) ||
    typeof repository.private !== "boolean"
  ) {
    throw new GitHubAppClientError(
      "github_response_invalid",
      "GitHub repository identity was invalid",
      false,
    );
  }
  return {
    id: decimalId(repository.id, "GitHub repository ID"),
    owner: ownerLogin,
    name,
    fullName,
    private: repository.private,
    defaultBranch: boundedString(repository.default_branch, "GitHub default branch", 255),
    cloneUrl,
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAXIMUM_RESPONSE_BYTES) {
    throw new GitHubAppClientError(
      "github_response_invalid",
      "GitHub response exceeded its byte limit",
      false,
    );
  }
  if (!response.ok) {
    throw new GitHubAppClientError(
      response.status === 401 || response.status === 403
        ? "github_authorization_failed"
        : response.status === 404
          ? "github_resource_not_found"
          : "github_request_failed",
      "GitHub request failed",
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }
  try {
    return bytes.byteLength === 0 ? {} : (JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    throw new GitHubAppClientError(
      "github_response_invalid",
      "GitHub returned invalid JSON",
      false,
    );
  }
}

export class GitHubAppClient {
  readonly #appId: string;
  readonly #privateKey: KeyObject;
  readonly #webhookSecret: Buffer;
  readonly #fetch: FetchLike;
  readonly #apiBaseUrl: URL;
  readonly #clock: () => number;

  constructor(options: {
    appId: string;
    privateKeyPem: string;
    webhookSecret: string;
    fetch?: FetchLike;
    apiBaseUrl?: string;
    clock?: () => number;
  }) {
    this.#appId = decimalId(options.appId, "GitHub App ID");
    try {
      this.#privateKey = createPrivateKey(options.privateKeyPem);
    } catch {
      throw new TypeError("GitHub App private key is invalid");
    }
    if (
      options.webhookSecret.length < 32 ||
      options.webhookSecret.length > 4_096 ||
      /[\r\n\u0000]/.test(options.webhookSecret)
    ) {
      throw new TypeError("GitHub App Webhook secret is invalid");
    }
    this.#webhookSecret = Buffer.from(options.webhookSecret, "utf8");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#apiBaseUrl = new URL(options.apiBaseUrl ?? "https://api.github.com/");
    if (this.#apiBaseUrl.protocol !== "https:" && this.#apiBaseUrl.hostname !== "127.0.0.1") {
      throw new TypeError("GitHub API base URL is invalid");
    }
    this.#clock = options.clock ?? Date.now;
  }

  verifyWebhook(body: Uint8Array, signature: string | undefined): boolean {
    if (signature === undefined || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
    const expected = createHmac("sha256", this.#webhookSecret).update(body).digest();
    return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
  }

  async installation(installationId: string): Promise<GitHubAppInstallation> {
    return parseInstallation(
      await this.#request(
        `app/installations/${decimalId(installationId, "GitHub installation ID")}`,
        {
          authorization: `Bearer ${this.#appJwt()}`,
        },
      ),
    );
  }

  async installationToken(
    installationId: string,
    repositoryId: string,
    permissions: Readonly<Record<string, "read" | "write">>,
  ): Promise<GitHubInstallationToken> {
    const numericRepositoryId = Number(repositoryId);
    if (!Number.isSafeInteger(numericRepositoryId) || numericRepositoryId < 1) {
      throw new GitHubAppClientError(
        "github_repository_id_unsupported",
        "GitHub repository ID exceeds the supported numeric range",
        false,
      );
    }
    const value = record(
      await this.#request(
        `app/installations/${decimalId(installationId, "GitHub installation ID")}/access_tokens`,
        { authorization: `Bearer ${this.#appJwt()}` },
        {
          method: "POST",
          body: JSON.stringify({ repository_ids: [numericRepositoryId], permissions }),
        },
      ),
    );
    const token = boundedString(value.token, "GitHub installation token", 4_096);
    const expiresAt = boundedString(value.expires_at, "GitHub token expiry", 64);
    return { token, expiresAt };
  }

  async repositories(installationId: string): Promise<readonly GitHubRepository[]> {
    const token = await this.#installationWideToken(installationId);
    const repositories: GitHubRepository[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const response = record(
        await this.#request(`installation/repositories?per_page=100&page=${String(page)}`, {
          authorization: `Bearer ${token.token}`,
        }),
      );
      if (!Array.isArray(response.repositories)) {
        throw new GitHubAppClientError(
          "github_response_invalid",
          "GitHub repository list was invalid",
          false,
        );
      }
      repositories.push(...response.repositories.map(parseRepository));
      if (response.repositories.length < 100) return repositories;
    }
    throw new GitHubAppClientError(
      "github_repository_limit",
      "GitHub installation exceeds the supported repository limit",
      false,
    );
  }

  async createPullRequest(input: {
    installationId: string;
    repositoryId: string;
    owner: string;
    repository: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ number: number; url: string }> {
    const token = await this.installationToken(input.installationId, input.repositoryId, {
      pull_requests: "write",
    });
    const result = record(
      await this.#request(
        `repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls`,
        { authorization: `Bearer ${token.token}` },
        {
          method: "POST",
          body: JSON.stringify({
            title: input.title,
            body: input.body,
            head: input.head,
            base: input.base,
          }),
        },
      ),
    );
    const number = Number(result.number);
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new GitHubAppClientError(
        "github_response_invalid",
        "GitHub PR number was invalid",
        false,
      );
    }
    return { number, url: boundedString(result.html_url, "GitHub PR URL", 2_048) };
  }

  async findPullRequest(input: {
    installationId: string;
    repositoryId: string;
    owner: string;
    repository: string;
    head: string;
  }): Promise<{ number: number; url: string } | undefined> {
    const token = await this.installationToken(input.installationId, input.repositoryId, {
      pull_requests: "read",
    });
    const values = await this.#request(
      `repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls?state=all&head=${encodeURIComponent(`${input.owner}:${input.head}`)}&per_page=10`,
      { authorization: `Bearer ${token.token}` },
    );
    if (!Array.isArray(values) || values.length === 0) return undefined;
    const result = record(values[0]);
    const number = Number(result.number);
    if (!Number.isSafeInteger(number) || number < 1) return undefined;
    return { number, url: boundedString(result.html_url, "GitHub PR URL", 2_048) };
  }

  async createIssueComment(input: {
    installationId: string;
    repositoryId: string;
    owner: string;
    repository: string;
    issueNumber: number;
    body: string;
  }): Promise<{ id: string }> {
    const token = await this.installationToken(input.installationId, input.repositoryId, {
      issues: "write",
    });
    const result = record(
      await this.#request(
        `repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/issues/${String(input.issueNumber)}/comments`,
        { authorization: `Bearer ${token.token}` },
        { method: "POST", body: JSON.stringify({ body: input.body }) },
      ),
    );
    return { id: decimalId(result.id, "GitHub issue comment ID") };
  }

  async findIssueComment(input: {
    installationId: string;
    repositoryId: string;
    owner: string;
    repository: string;
    issueNumber: number;
    marker: string;
  }): Promise<{ id: string } | undefined> {
    const token = await this.installationToken(input.installationId, input.repositoryId, {
      issues: "read",
    });
    const values = await this.#request(
      `repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/issues/${String(input.issueNumber)}/comments?per_page=100&sort=created&direction=desc`,
      { authorization: `Bearer ${token.token}` },
    );
    if (!Array.isArray(values)) {
      throw new GitHubAppClientError(
        "github_response_invalid",
        "GitHub issue comment list was invalid",
        false,
      );
    }
    for (const value of values) {
      const comment = record(value);
      if (typeof comment.body === "string" && comment.body.includes(input.marker)) {
        return { id: decimalId(comment.id, "GitHub issue comment ID") };
      }
    }
    return undefined;
  }

  async #installationWideToken(installationId: string): Promise<GitHubInstallationToken> {
    const value = record(
      await this.#request(
        `app/installations/${decimalId(installationId, "GitHub installation ID")}/access_tokens`,
        { authorization: `Bearer ${this.#appJwt()}` },
        { method: "POST", body: JSON.stringify({ permissions: { metadata: "read" } }) },
      ),
    );
    return {
      token: boundedString(value.token, "GitHub installation token", 4_096),
      expiresAt: boundedString(value.expires_at, "GitHub token expiry", 64),
    };
  }

  #appJwt(): string {
    const now = Math.floor(this.#clock() / 1_000);
    const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
      "base64url",
    );
    const encodedPayload = Buffer.from(
      JSON.stringify({ iat: now - 30, exp: now + 9 * 60, iss: this.#appId }),
    ).toString("base64url");
    const input = `${encodedHeader}.${encodedPayload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(input);
    signer.end();
    return `${input}.${signer.sign(this.#privateKey).toString("base64url")}`;
  }

  async #request(
    path: string,
    headers: { authorization: string },
    init: RequestInit = {},
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#apiBaseUrl), {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          authorization: headers.authorization,
          "content-type": "application/json",
          "user-agent": "PiCloud-GitHub-App/1",
          "x-github-api-version": GITHUB_API_VERSION,
          ...(init.headers ?? {}),
        },
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
    } catch {
      throw new GitHubAppClientError("github_unavailable", "GitHub is unavailable", true);
    }
    return boundedJson(response);
  }
}
