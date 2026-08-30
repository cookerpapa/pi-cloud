import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const KEY_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type GitLabProjectCredential = Readonly<{
  accessToken: string;
  webhookSigningToken: string;
}>;

export type SourceControlCredentialIdentity = Readonly<{
  tenantId: string;
  installationId: string;
  provider: "gitlab";
  version: number;
}>;

export type SealedSourceControlCredential = Readonly<{
  keyVersion: number;
  nonce: string;
  ciphertext: string;
  authTag: string;
  secretSha256: string;
}>;

class SourceControlCredentialVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceControlCredentialVaultError";
  }
}

function masterKey(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new SourceControlCredentialVaultError("Source-control credential master key is invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new SourceControlCredentialVaultError("Source-control credential master key is invalid");
  }
  return decoded;
}

function bounded(value: string, label: string, maximum: number): string {
  if (value.length < 1 || value.length > maximum || /[\r\n\0]/.test(value)) {
    throw new SourceControlCredentialVaultError(`${label} is invalid`);
  }
  return value;
}

function payload(value: GitLabProjectCredential): string {
  const accessToken = bounded(value.accessToken, "GitLab project access token", 4_096);
  const webhookSigningToken = bounded(
    value.webhookSigningToken,
    "GitLab Webhook signing token",
    256,
  );
  if (!/^whsec_[A-Za-z0-9+/]{43}=$/.test(webhookSigningToken)) {
    throw new SourceControlCredentialVaultError("GitLab Webhook signing token is invalid");
  }
  return JSON.stringify({ accessToken, webhookSigningToken });
}

function associatedData(identity: SourceControlCredentialIdentity): Buffer {
  if (!Number.isSafeInteger(identity.version) || identity.version < 1) {
    throw new SourceControlCredentialVaultError("Source-control credential version is invalid");
  }
  return Buffer.from(
    JSON.stringify({
      format: "pi-cloud.source-control-credential.v1",
      tenantId: bounded(identity.tenantId, "Tenant ID", 256),
      installationId: bounded(identity.installationId, "Installation ID", 256),
      provider: identity.provider,
      version: identity.version,
      keyVersion: KEY_VERSION,
    }),
    "utf8",
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class SourceControlCredentialVault {
  readonly #key: Buffer;
  readonly #random: (size: number) => Buffer;

  constructor(key: string, options: { randomBytes?: (size: number) => Buffer } = {}) {
    this.#key = masterKey(key);
    this.#random = options.randomBytes ?? randomBytes;
  }

  seal(
    identity: SourceControlCredentialIdentity,
    credential: GitLabProjectCredential,
  ): SealedSourceControlCredential {
    const plaintext = payload(credential);
    const nonce = this.#random(NONCE_BYTES);
    if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) {
      throw new SourceControlCredentialVaultError("Source-control credential nonce is invalid");
    }
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(associatedData(identity));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      keyVersion: KEY_VERSION,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
      secretSha256: digest(plaintext),
    };
  }

  open(
    identity: SourceControlCredentialIdentity,
    sealed: SealedSourceControlCredential,
  ): GitLabProjectCredential {
    if (sealed.keyVersion !== KEY_VERSION) {
      throw new SourceControlCredentialVaultError("Source-control credential key is unavailable");
    }
    try {
      const nonce = Buffer.from(sealed.nonce, "base64url");
      const tag = Buffer.from(sealed.authTag, "base64url");
      const ciphertext = Buffer.from(sealed.ciphertext, "base64url");
      if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new Error("shape");
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(associatedData(identity));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        "utf8",
      );
      if (digest(plaintext) !== sealed.secretSha256) throw new Error("digest");
      const parsed = JSON.parse(plaintext) as GitLabProjectCredential;
      payload(parsed);
      return parsed;
    } catch {
      throw new SourceControlCredentialVaultError(
        "Source-control credential could not be authenticated",
      );
    }
  }
}
