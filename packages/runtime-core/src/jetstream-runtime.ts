import {
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager,
  type StreamConfig,
  type StreamInfo,
} from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { createHash } from "node:crypto";

export const AGENT_EVENT_STREAM_NAME = "PI_CLOUD_AGENT_EVENTS";
export const AGENT_EVENT_SUBJECT_PREFIX = "pi.events";
export const AGENT_LIVE_SUBJECT_PREFIX = "pi.live";
export const PI_SESSION_MUTATION_STREAM_NAME = "PI_CLOUD_SESSION_MUTATIONS";
export const PI_SESSION_MUTATION_SUBJECT_PREFIX = "pi.session-mutations";

export type JetStreamRuntimeOptions = Readonly<{
  servers: readonly string[];
  clientName: string;
}>;

export type PiCloudJetStream = Readonly<{
  connection: Awaited<ReturnType<typeof connect>>;
  client: JetStreamClient;
  manager: JetStreamManager;
}>;

function bounded(value: string, name: string, maximum = 512): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

export async function connectPiCloudJetStream(
  options: JetStreamRuntimeOptions,
): Promise<PiCloudJetStream> {
  if (options.servers.length < 1 || options.servers.length > 64) {
    throw new TypeError("JetStream server list is invalid");
  }
  const connection = await connect({
    servers: options.servers.map((server) => bounded(server, "JetStream server")),
    name: bounded(options.clientName, "JetStream client name", 128),
    maxReconnectAttempts: -1,
  });
  const deadline = Date.now() + 30_000;
  let manager: JetStreamManager | undefined;
  let lastError: unknown;
  while (manager === undefined && Date.now() < deadline) {
    try {
      manager = await jetstreamManager(connection);
    } catch (error: unknown) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
  if (manager === undefined) {
    await connection.close().catch(() => undefined);
    throw lastError ?? new Error("JetStream management API did not become ready");
  }
  return { connection, client: jetstream(connection), manager };
}

export function sessionSubjectToken(sessionId: string): string {
  if (sessionId.length < 1 || sessionId.length > 512 || sessionId.includes("\0")) {
    throw new TypeError("Session ID is invalid");
  }
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

export function agentEventSubject(sessionId: string): string {
  return `${AGENT_EVENT_SUBJECT_PREFIX}.${sessionSubjectToken(sessionId)}`;
}

export function agentLiveSubject(sessionId: string): string {
  return `${AGENT_LIVE_SUBJECT_PREFIX}.${sessionSubjectToken(sessionId)}`;
}

export function piSessionMutationSubject(sessionId: string): string {
  return `${PI_SESSION_MUTATION_SUBJECT_PREFIX}.${sessionSubjectToken(sessionId)}`;
}

export type JetStreamAuthorityConfiguration = Readonly<{
  replicas: number;
  eventRetentionMs: number;
  maximumEventsPerSession: number;
}>;

function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function agentEventConfig(configuration: JetStreamAuthorityConfiguration): Partial<StreamConfig> & {
  name: string;
} {
  return {
    name: AGENT_EVENT_STREAM_NAME,
    subjects: [`${AGENT_EVENT_SUBJECT_PREFIX}.>`],
    storage: StorageType.File,
    retention: RetentionPolicy.Limits,
    discard: DiscardPolicy.Old,
    num_replicas: positiveInteger(configuration.replicas, "JetStream replicas", 5),
    max_age:
      positiveInteger(configuration.eventRetentionMs, "JetStream event retention") * 1_000_000,
    max_msgs_per_subject: positiveInteger(
      configuration.maximumEventsPerSession,
      "JetStream per-Session event limit",
      1_000_000,
    ),
    duplicate_window: 10 * 60 * 1_000_000_000,
    republish: {
      src: `${AGENT_EVENT_SUBJECT_PREFIX}.>`,
      dest: `${AGENT_LIVE_SUBJECT_PREFIX}.>`,
    },
  };
}

function sessionMutationConfig(
  configuration: JetStreamAuthorityConfiguration,
): Partial<StreamConfig> & { name: string } {
  return {
    name: PI_SESSION_MUTATION_STREAM_NAME,
    subjects: [`${PI_SESSION_MUTATION_SUBJECT_PREFIX}.>`],
    storage: StorageType.File,
    retention: RetentionPolicy.Limits,
    discard: DiscardPolicy.Old,
    num_replicas: positiveInteger(configuration.replicas, "JetStream replicas", 5),
    max_age:
      positiveInteger(configuration.eventRetentionMs, "JetStream mutation retention") * 1_000_000,
    duplicate_window: 10 * 60 * 1_000_000_000,
  };
}

function sameStringSet(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function verifyStream(info: StreamInfo, expected: Partial<StreamConfig> & { name: string }): void {
  if (
    info.config.name !== expected.name ||
    info.config.storage !== expected.storage ||
    info.config.retention !== expected.retention ||
    info.config.num_replicas !== expected.num_replicas ||
    info.config.max_age !== expected.max_age ||
    !sameStringSet(info.config.subjects, expected.subjects ?? []) ||
    (expected.republish === undefined
      ? info.config.republish !== undefined
      : info.config.republish?.src !== expected.republish.src ||
        info.config.republish?.dest !== expected.republish.dest)
  ) {
    throw new Error(`JetStream ${expected.name} configuration is incompatible`);
  }
}

async function ensureStream(
  manager: JetStreamManager,
  expected: Partial<StreamConfig> & { name: string },
): Promise<void> {
  try {
    verifyStream(await manager.streams.info(expected.name), expected);
    return;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("configuration is incompatible")) {
      throw error;
    }
  }
  try {
    await manager.streams.add(expected);
  } catch {
    // Concurrent Control Plane replicas may create the same stream. The
    // authoritative verification below decides whether it is adoptable.
  }
  verifyStream(await manager.streams.info(expected.name), expected);
}

export async function ensurePiCloudStreams(
  runtime: PiCloudJetStream,
  configuration: JetStreamAuthorityConfiguration,
): Promise<void> {
  await ensureStream(runtime.manager, agentEventConfig(configuration));
  await ensureStream(runtime.manager, sessionMutationConfig(configuration));
}
