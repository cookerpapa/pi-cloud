import type {
  Database,
  WorkerRetirementReason,
  SupervisorConnectionCloseReason,
  SupervisorConnectionState,
} from "@pi-cloud/database";
import { transitionWorker, type WorkerState } from "@pi-cloud/domain";
import {
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type SupervisorHeartbeatAckMessage,
  type SupervisorRegisterMessage,
  type SupervisorRegisteredMessage,
} from "@pi-cloud/protocol";
import { PINNED_PI_DURABLE_VERSION } from "@pi-cloud/protocol";
import { confirmStoppedWorkerExecutions } from "@pi-cloud/runtime-core/quarantined-session-recovery";
import { createHash } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { databaseTime } from "@pi-cloud/database";
import type {
  WorkerRetirementResult,
  AssignmentReconciliationResult,
} from "./assignment-reconciler.ts";
import {
  SessionLeaseCoordinator,
  SessionLeaseCoordinatorError,
  type SupervisorConnectionGuard,
} from "@pi-cloud/runtime-core/session-lease-coordinator";

const DEFAULT_SUPERVISOR_VERSION = "0.1.0";
const DEFAULT_PI_PACKAGE_NAME = "@earendil-works/pi-durable";
const DEFAULT_REQUIRED_CAPABILITIES = ["pi.sdk"] as const;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_RETIREMENT_RETRY_DELAY_MS = 5_000;
const DEFAULT_RETIREMENT_CLAIM_DURATION_MS = 120_000;
const DEFAULT_SWEEP_LIMIT = 100;
const DEFAULT_RETIREMENT_LIMIT = 10;

export type SupervisorTransportAuthority = {
  supervisorId: string;
  bootId: string;
  sandboxId: string;
  transportId: string;
};

export type SupervisorBootIdentity = {
  supervisorId: string;
  bootId: string;
  sandboxId: string;
};

export interface SupervisorOwnerBoundary {
  /**
   * Resolve only after this exact boot cannot create another execution runtime.
   * A transport close or missed heartbeat alone does not satisfy this contract.
   */
  stopAndConfirm(identity: SupervisorBootIdentity): Promise<void>;
}

export interface SupervisorAssignmentRetirer {
  retireWorker(): Promise<WorkerRetirementResult>;
  retireExpiredAssignments(limit?: number): Promise<AssignmentReconciliationResult>;
  retireFencedWorker?(): Promise<WorkerRetirementResult>;
}

export type SupervisorConnectionManagerOptions = {
  database: Kysely<Database>;
  controlPlaneInstanceId: string;
  ownerBoundary: SupervisorOwnerBoundary;
  assignmentRetirerFactory: (identity: SupervisorBootIdentity) => SupervisorAssignmentRetirer;
  clock?: () => Date;
  idGenerator?: () => string;
  expectedSupervisorVersion?: string;
  expectedPiPackageName?: string;
  expectedPiVersion?: string;
  requiredCapabilities?: readonly string[];
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  leaseDurationMs?: number;
  retirementRetryDelayMs?: number;
  retirementClaimDurationMs?: number;
};

export type SupervisorConnectionSweepResult = {
  scannedConnections: number;
  expiredConnections: number;
  expiredConnectionIds: readonly string[];
};

export type SupervisorRetirementWorkResult =
  | { kind: "idle" }
  | {
      kind: "retired";
      identity: SupervisorBootIdentity;
      attempt: number;
      reconciliation: WorkerRetirementResult;
    }
  | {
      kind: "retry_scheduled" | "blocked";
      identity: SupervisorBootIdentity;
      attempt: number;
      errorCode: string;
    };

export type SupervisorExpirySweepResult = {
  connections: SupervisorConnectionSweepResult;
  expiredAssignments: number;
};

export class SupervisorConnectionManagerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "SupervisorConnectionManagerError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class SupervisorOwnerBoundaryError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "SupervisorOwnerBoundaryError";
    this.code = code;
    this.retryable = retryable;
  }
}

type WorkerIdentityRow = {
  id: string;
  supervisor_id: string;
  boot_id: string;
  state: WorkerState;
  max_concurrent_sessions: number | null;
};

type ConnectionRow = {
  connection_id: string;
  transport_id: string;
  registration_message_id: string;
  registered_message_id: string;
  worker_id: string;
  supervisor_id: string;
  boot_id: string;
  control_plane_instance_id: string;
  state: SupervisorConnectionState;
  registration_fingerprint: string;
  selected_protocol_version: number;
  heartbeat_interval_ms: number;
  heartbeat_timeout_ms: number;
  registered_at: Date;
  expires_at: Date;
};

type RetirementClaim = {
  identity: SupervisorBootIdentity;
  claimId: string;
  attempt: number;
};

type RegistrationTransactionResult =
  | { kind: "accepted"; connection: ConnectionRow }
  | { kind: "rejected"; code: string; message: string; retryable: boolean };

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("supervisor connection manager clock must return a valid Date");
  }
  return value;
}

function requireUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty`);
  return value;
}

function normalizedCapabilities(values: readonly string[]): readonly string[] {
  const result = [...new Set(values)].sort();
  if (result.length !== values.length) {
    throw new TypeError("requiredCapabilities must not contain duplicates");
  }
  return result;
}

function registrationFingerprint(message: SupervisorRegisterMessage): string {
  const normalized = {
    protocolVersion: message.protocolVersion,
    sentAt: message.sentAt,
    payload: {
      ...message.payload,
      supportedProtocolVersions: [...message.payload.supportedProtocolVersions].sort(
        (left, right) => left - right,
      ),
      capabilities: [...message.payload.capabilities].sort(),
    },
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function safeErrorCode(error: unknown): { code: string; retryable: boolean } {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_.-]{0,127}$/.test(error.code) &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  ) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: "supervisor_retirement_failed", retryable: true };
}

function expectOne(updatedRows: bigint, description: string): void {
  if (updatedRows !== 1n) {
    throw new SupervisorConnectionManagerError(
      "supervisor_connection_invariant",
      `${description} changed ${updatedRows} rows`,
      false,
    );
  }
}

export class SupervisorConnectionManager {
  readonly #database: Kysely<Database>;
  readonly #controlPlaneInstanceId: string;
  readonly #ownerBoundary: SupervisorOwnerBoundary;
  readonly #assignmentRetirerFactory: (
    identity: SupervisorBootIdentity,
  ) => SupervisorAssignmentRetirer;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #expectedSupervisorVersion: string;
  readonly #expectedPiPackageName: string;
  readonly #expectedPiVersion: string;
  readonly #requiredCapabilities: readonly string[];
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #leaseDurationMs: number;
  readonly #retirementRetryDelayMs: number;
  readonly #retirementClaimDurationMs: number;

  get controlPlaneInstanceId(): string {
    return this.#controlPlaneInstanceId;
  }

  constructor(options: SupervisorConnectionManagerOptions) {
    this.#database = options.database;
    this.#controlPlaneInstanceId = requireUuid(
      options.controlPlaneInstanceId,
      "controlPlaneInstanceId",
    );
    this.#ownerBoundary = options.ownerBoundary;
    this.#assignmentRetirerFactory = options.assignmentRetirerFactory;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#expectedSupervisorVersion = nonEmpty(
      options.expectedSupervisorVersion ?? DEFAULT_SUPERVISOR_VERSION,
      "expectedSupervisorVersion",
    );
    this.#expectedPiPackageName = nonEmpty(
      options.expectedPiPackageName ?? DEFAULT_PI_PACKAGE_NAME,
      "expectedPiPackageName",
    );
    this.#expectedPiVersion = nonEmpty(
      options.expectedPiVersion ?? PINNED_PI_DURABLE_VERSION,
      "expectedPiVersion",
    );
    this.#requiredCapabilities = normalizedCapabilities(
      options.requiredCapabilities ?? DEFAULT_REQUIRED_CAPABILITIES,
    );
    this.#heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs",
    );
    this.#heartbeatTimeoutMs = positiveInteger(
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      "heartbeatTimeoutMs",
    );
    this.#leaseDurationMs = positiveInteger(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "leaseDurationMs",
    );
    this.#retirementRetryDelayMs = positiveInteger(
      options.retirementRetryDelayMs ?? DEFAULT_RETIREMENT_RETRY_DELAY_MS,
      "retirementRetryDelayMs",
    );
    this.#retirementClaimDurationMs = positiveInteger(
      options.retirementClaimDurationMs ?? DEFAULT_RETIREMENT_CLAIM_DURATION_MS,
      "retirementClaimDurationMs",
    );
    if (this.#heartbeatTimeoutMs <= this.#heartbeatIntervalMs) {
      throw new TypeError("heartbeatTimeoutMs must be greater than heartbeatIntervalMs");
    }
    if (this.#leaseDurationMs < this.#heartbeatTimeoutMs) {
      throw new TypeError("leaseDurationMs must be at least heartbeatTimeoutMs");
    }
  }

  async register(
    value: unknown,
    authority: SupervisorTransportAuthority,
  ): Promise<SupervisorRegisteredMessage> {
    const message = this.#parseRegistration(value);
    this.#validateAuthority(authority, message.payload);
    const fingerprint = registrationFingerprint(message);
    const result = await this.#database
      .transaction()
      .execute(async (transaction): Promise<RegistrationTransactionResult> => {
        // Serialize against Boot provisioning/revocation, including a handshake
        // authorized before a replacement Boot acquired its credential.
        await this.#lockHost(transaction, authority.supervisorId);
        const workers = await transaction
          .selectFrom("workers")
          .select(["id", "supervisor_id", "boot_id", "state", "max_concurrent_sessions"])
          .where("supervisor_id", "=", authority.supervisorId)
          .orderBy("id", "asc")
          .forUpdate()
          .execute();
        const current = workers.find((sandbox) => sandbox.id === authority.sandboxId);
        if (
          current === undefined ||
          current.supervisor_id !== authority.supervisorId ||
          current.boot_id !== authority.bootId
        ) {
          return this.#registrationRejection(
            "unauthorized_sandbox",
            "Supervisor registration does not match a provisioned sandbox",
            false,
          );
        }
        if (
          workers.some(
            (sandbox) => sandbox.id !== current.id && sandbox.boot_id === authority.bootId,
          )
        ) {
          return this.#registrationRejection(
            "boot_identity_collision",
            "Supervisor boot is already bound to another sandbox",
            false,
          );
        }
        if (message.payload.maxConcurrentSessions !== current.max_concurrent_sessions) {
          return this.#registrationRejection(
            "capacity_mismatch",
            "Supervisor capacity does not match its provisioned sandbox",
            false,
          );
        }
        if (!["provisioning", "ready"].includes(current.state)) {
          return this.#registrationRejection(
            "sandbox_unavailable",
            "Supervisor sandbox cannot be registered",
            false,
          );
        }

        const sandboxIds = workers.map((sandbox) => sandbox.id);
        const connections =
          sandboxIds.length === 0
            ? []
            : await transaction
                .selectFrom("supervisor_connections")
                .select([
                  "connection_id",
                  "transport_id",
                  "registration_message_id",
                  "registered_message_id",
                  "worker_id",
                  "supervisor_id",
                  "boot_id",
                  "control_plane_instance_id",
                  "state",
                  "registration_fingerprint",
                  "selected_protocol_version",
                  "heartbeat_interval_ms",
                  "heartbeat_timeout_ms",
                  "registered_at",
                  "expires_at",
                ])
                .where("worker_id", "in", sandboxIds)
                .orderBy("connection_id", "asc")
                .forUpdate()
                .execute();
        const now = await databaseTime(transaction);
        // A credential may expire while the preceding row locks are awaited.
        if (!(await this.#bootAuthorized(transaction, current))) {
          return this.#registrationRejection(
            "boot_unavailable",
            "Supervisor boot authorization is no longer current",
            false,
          );
        }
        const transportConnection = connections.find(
          (connection) => connection.transport_id === authority.transportId,
        );
        if (transportConnection !== undefined) {
          if (
            transportConnection.registration_message_id !== message.messageId ||
            transportConnection.registration_fingerprint !== fingerprint ||
            transportConnection.supervisor_id !== authority.supervisorId ||
            transportConnection.boot_id !== authority.bootId ||
            transportConnection.worker_id !== authority.sandboxId ||
            transportConnection.control_plane_instance_id !== this.#controlPlaneInstanceId
          ) {
            return this.#registrationRejection(
              "registration_conflict",
              "Transport registration identity changed",
              false,
            );
          }
          if (
            transportConnection.state === "active" &&
            new Date(transportConnection.expires_at).valueOf() > now.valueOf()
          ) {
            return { kind: "accepted", connection: transportConnection };
          }
          if (transportConnection.state === "active") {
            const retained = await this.#expireLockedConnection(
              transaction,
              current,
              transportConnection.connection_id,
              now,
            );
            return this.#registrationRejection(
              "stale_registration",
              "Expired transport must reconnect",
              retained,
            );
          }
          return this.#registrationRejection(
            "stale_registration",
            "Supervisor registration is no longer current",
            transportConnection.state === "expired" &&
              !connections.some((c) => c.worker_id === current.id && c.state === "active") &&
              (await this.#canRetainBoot(transaction, current)),
          );
        }

        const registrationReplay = await transaction
          .selectFrom("supervisor_connections")
          .select(["transport_id"])
          .where("registration_message_id", "=", message.messageId)
          .forUpdate()
          .executeTakeFirst();
        if (registrationReplay !== undefined) {
          return this.#registrationRejection(
            "registration_replay",
            "Registration message was already used by another transport",
            false,
          );
        }

        const currentConnections = connections.filter(
          (connection) => connection.worker_id === current.id,
        );
        let currentActive = currentConnections.find((connection) => connection.state === "active");
        if (current.state === "provisioning" && currentConnections.length !== 0) {
          return this.#registrationRejection(
            "registration_invariant",
            "Provisioning sandbox already has connection history",
            false,
          );
        }
        if (
          current.state === "ready" &&
          currentActive === undefined &&
          currentConnections.length !== 0 &&
          !(
            currentConnections.some((c) => c.state === "expired") &&
            (await this.#canRetainBoot(transaction, current))
          )
        ) {
          return this.#registrationRejection(
            "stale_registration",
            "Supervisor sandbox has no current connection",
            false,
          );
        }
        if (
          currentActive !== undefined &&
          new Date(currentActive.expires_at).valueOf() <= now.valueOf()
        ) {
          if (
            !(await this.#expireLockedConnection(
              transaction,
              current,
              currentActive.connection_id,
              now,
            ))
          ) {
            return this.#registrationRejection(
              "stale_registration",
              "Expired supervisor connection cannot be revived",
              false,
            );
          }
          currentActive = undefined;
        }

        this.#validateRegistrationPolicy(message);
        for (const oldWorker of workers) {
          if (oldWorker.id === current.id || oldWorker.state === "terminated") continue;
          await this.#fenceSandbox(transaction, oldWorker, "new_boot", now);
        }
        if (currentActive !== undefined) {
          const superseded = await transaction
            .updateTable("supervisor_connections")
            .set({ state: "superseded", close_reason: "reconnected", closed_at: now })
            .where("connection_id", "=", currentActive.connection_id)
            .where("state", "=", "active")
            .executeTakeFirst();
          expectOne(superseded.numUpdatedRows, "superseding a supervisor connection");
        }
        if (current.state === "provisioning") {
          await transaction
            .updateTable("workers")
            .set({ state: transitionWorker(current.state, "ready"), updated_at: now })
            .where("id", "=", current.id)
            .where("state", "=", current.state)
            .executeTakeFirstOrThrow();
        }

        const connectionId = requireUuid(this.#idGenerator(), "generated connectionId");
        const registeredMessageId = requireUuid(
          this.#idGenerator(),
          "generated registered messageId",
        );
        const persisted = await transaction
          .insertInto("supervisor_connections")
          .values({
            connection_id: connectionId,
            transport_id: authority.transportId,
            registration_message_id: message.messageId,
            registered_message_id: registeredMessageId,
            worker_id: authority.sandboxId,
            supervisor_id: authority.supervisorId,
            boot_id: authority.bootId,
            control_plane_instance_id: this.#controlPlaneInstanceId,
            state: "active",
            close_reason: null,
            registration_fingerprint: fingerprint,
            supervisor_version: message.payload.supervisorVersion,
            pi_package_name: message.payload.pi.packageName,
            pi_version: message.payload.pi.version,
            supported_protocol_versions: [...message.payload.supportedProtocolVersions],
            capabilities: [...message.payload.capabilities],
            selected_protocol_version: 1,
            heartbeat_interval_ms: this.#heartbeatIntervalMs,
            heartbeat_timeout_ms: this.#heartbeatTimeoutMs,
            accepting_assignments: message.payload.acceptingAssignments,
            registered_at: sql<Date>`clock_timestamp()`,
            last_heartbeat_at: sql<Date>`clock_timestamp()`,
            expires_at: sql<Date>`clock_timestamp() + ${this.#heartbeatTimeoutMs} * interval '1 millisecond'`,
            closed_at: null,
          })
          .returning(["registered_at", "expires_at"])
          .executeTakeFirstOrThrow();
        return {
          kind: "accepted",
          connection: {
            connection_id: connectionId,
            transport_id: authority.transportId,
            registration_message_id: message.messageId,
            registered_message_id: registeredMessageId,
            worker_id: authority.sandboxId,
            supervisor_id: authority.supervisorId,
            boot_id: authority.bootId,
            control_plane_instance_id: this.#controlPlaneInstanceId,
            state: "active",
            registration_fingerprint: fingerprint,
            selected_protocol_version: 1,
            heartbeat_interval_ms: this.#heartbeatIntervalMs,
            heartbeat_timeout_ms: this.#heartbeatTimeoutMs,
            registered_at: persisted.registered_at,
            expires_at: persisted.expires_at,
          },
        };
      });
    if (result.kind === "rejected") {
      throw new SupervisorConnectionManagerError(result.code, result.message, result.retryable);
    }
    return this.#registrationAcknowledgement(result.connection);
  }

  async heartbeat(
    value: unknown,
    authority: SupervisorTransportAuthority,
  ): Promise<SupervisorHeartbeatAckMessage> {
    const parsed = parseSupervisorToControlMessage(value);
    if (parsed.type !== "supervisor.heartbeat") {
      throw new SupervisorConnectionManagerError(
        "invalid_heartbeat",
        "Expected a supervisor heartbeat",
        false,
      );
    }
    this.#validateAuthority(authority, parsed.payload);
    if (parsed.payload.families.length === 0) {
      const updated = await this.#database.transaction().execute(async (tx) => {
        await tx
          .selectFrom("supervisor_connections")
          .select("connection_id")
          .where("connection_id", "=", parsed.payload.connectionId)
          .forNoKeyUpdate()
          .execute();
        return tx
          .updateTable("supervisor_connections")
          .set({
            accepting_assignments: parsed.payload.acceptingAssignments,
            last_heartbeat_at: sql<Date>`clock_timestamp()`,
            expires_at: sql<Date>`clock_timestamp() + ${this.#heartbeatTimeoutMs} * interval '1 millisecond'`,
          })
          .where("connection_id", "=", parsed.payload.connectionId)
          .where("worker_id", "=", authority.sandboxId)
          .where("supervisor_id", "=", authority.supervisorId)
          .where("boot_id", "=", authority.bootId)
          .where("transport_id", "=", authority.transportId)
          .where("control_plane_instance_id", "=", this.#controlPlaneInstanceId)
          .where("state", "=", "active")
          .where("expires_at", ">", sql<Date>`clock_timestamp()`)
          .returning("last_heartbeat_at")
          .executeTakeFirst();
      });
      if (!updated) {
        throw await this.#staleConnection(parsed.payload.connectionId, authority);
      }
      const acknowledgement = parseControlToSupervisorMessage({
        protocolVersion: 1,
        messageId: this.#idGenerator(),
        sentAt: updated.last_heartbeat_at.toISOString(),
        type: "supervisor.heartbeat.ack",
        payload: {
          acknowledgedMessageId: parsed.messageId,
          connectionId: parsed.payload.connectionId,
          familyLeaseRenewals: [],
          familyLeaseDeferrals: [],
        },
      });
      if (acknowledgement.type !== "supervisor.heartbeat.ack") {
        throw new SupervisorConnectionManagerError(
          "heartbeat_ack_invariant",
          "Supervisor heartbeat acknowledgement was invalid",
          false,
        );
      }
      return acknowledgement;
    }
    const coordinator = await this.executionReferenceCoordinator(
      parsed.payload.connectionId,
      authority,
    );
    try {
      return await coordinator.renewFromHeartbeat(parsed);
    } catch (error: unknown) {
      if (error instanceof SessionLeaseCoordinatorError) {
        if (error.code === "stale_connection")
          throw await this.#staleConnection(parsed.payload.connectionId, authority);
        throw new SupervisorConnectionManagerError(
          error.code,
          "Supervisor heartbeat was rejected",
          error.retryable,
        );
      }
      throw error;
    }
  }

  async assertCurrentConnection(
    connectionId: string,
    authority: SupervisorTransportAuthority,
  ): Promise<void> {
    await this.#currentConnection(connectionId, authority);
  }

  async executionReferenceCoordinator(
    connectionId: string,
    authority: SupervisorTransportAuthority,
  ): Promise<SessionLeaseCoordinator> {
    const connection = await this.#currentConnection(connectionId, authority);
    const guard: SupervisorConnectionGuard = {
      controlPlaneInstanceId: this.#controlPlaneInstanceId,
      transportId: authority.transportId,
      heartbeatTimeoutMs: connection.heartbeat_timeout_ms,
    };
    return new SessionLeaseCoordinator({
      database: this.#database,
      workerId: authority.sandboxId,
      clock: this.#clock,
      idGenerator: this.#idGenerator,
      leaseDurationMs: this.#leaseDurationMs,
      heartbeatConnectionId: connectionId,
      connectionGuard: guard,
    });
  }

  async #currentConnection(
    connectionId: string,
    authority: SupervisorTransportAuthority,
  ): Promise<{ heartbeat_timeout_ms: number }> {
    requireUuid(connectionId, "connectionId");
    this.#validateAuthorityShape(authority);
    const connection = await this.#database
      .selectFrom("supervisor_connections")
      .select([
        "worker_id",
        "supervisor_id",
        "boot_id",
        "transport_id",
        "control_plane_instance_id",
        "heartbeat_timeout_ms",
        "state",
        "expires_at",
      ])
      .where("connection_id", "=", connectionId)
      .where("expires_at", ">", sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    if (
      connection === undefined ||
      connection.worker_id !== authority.sandboxId ||
      connection.supervisor_id !== authority.supervisorId ||
      connection.boot_id !== authority.bootId ||
      connection.transport_id !== authority.transportId ||
      connection.control_plane_instance_id !== this.#controlPlaneInstanceId ||
      connection.state !== "active"
    ) {
      throw await this.#staleConnection(connectionId, authority);
    }
    return connection;
  }

  async expireConnections(limit = DEFAULT_SWEEP_LIMIT): Promise<SupervisorConnectionSweepResult> {
    const boundedLimit = positiveInteger(limit, "limit");
    const candidates = await this.#database
      .selectFrom("supervisor_connections")
      .select(["connection_id"])
      .where("state", "=", "active")
      .where("expires_at", "<=", sql<Date>`clock_timestamp()`)
      .orderBy("expires_at", "asc")
      .orderBy("connection_id", "asc")
      .limit(boundedLimit)
      .execute();
    const expiredConnectionIds: string[] = [];
    for (const candidate of candidates) {
      const expired = await this.#expireConnection(candidate.connection_id);
      if (expired) expiredConnectionIds.push(candidate.connection_id);
    }
    return {
      scannedConnections: candidates.length,
      expiredConnections: expiredConnectionIds.length,
      expiredConnectionIds,
    };
  }

  async processNextRetirement(): Promise<SupervisorRetirementWorkResult> {
    const claim = await this.#claimRetirement(validDate(this.#clock));
    if (claim === undefined) return { kind: "idle" };
    try {
      const retirer = this.#assignmentRetirerFactory(claim.identity);
      let reconciliation: WorkerRetirementResult;
      let ownerStopConfirmed = false;
      try {
        await this.#ownerBoundary.stopAndConfirm(claim.identity);
        ownerStopConfirmed = true;
        await confirmStoppedWorkerExecutions(this.#database, claim.identity.sandboxId);
        await this.#renewRetirementClaim(claim, validDate(this.#clock));
        reconciliation = await retirer.retireWorker();
      } catch (error: unknown) {
        const normalized = safeErrorCode(error);
        if (
          retirer.retireFencedWorker === undefined ||
          (!ownerStopConfirmed &&
            normalized.code !== "supervisor_management_unavailable" &&
            normalized.code !== "boot_generation_unknown") ||
          (ownerStopConfirmed && !normalized.retryable)
        ) {
          throw error;
        }
        // The connection, Sandbox row and Session lease were fenced before
        // retirement became eligible. Once owner-stop also confirms, that
        // Worker intentionally exits, so a following inventory request can
        // race with its management endpoint disappearing. Either proof is
        // sufficient to settle durable state without stranding the Session.
        await this.#renewRetirementClaim(claim, validDate(this.#clock));
        reconciliation = await retirer.retireFencedWorker();
      }
      await this.#completeRetirementClaim(claim, validDate(this.#clock));
      return {
        kind: "retired",
        identity: claim.identity,
        attempt: claim.attempt,
        reconciliation,
      };
    } catch (error: unknown) {
      const normalized = safeErrorCode(error);
      const state = normalized.retryable ? "pending" : "blocked";
      await this.#failRetirementClaim(claim, normalized.code, state, validDate(this.#clock));
      return {
        kind: normalized.retryable ? "retry_scheduled" : "blocked",
        identity: claim.identity,
        attempt: claim.attempt,
        errorCode: normalized.code,
      };
    }
  }

  async sweepExpiredExecutions(
    options: {
      connectionLimit?: number;
      leaseLimit?: number;
    } = {},
  ): Promise<SupervisorExpirySweepResult> {
    const leaseLimit = positiveInteger(
      options.leaseLimit ?? DEFAULT_RETIREMENT_LIMIT,
      "leaseLimit",
    );
    const connections = await this.expireConnections(
      options.connectionLimit ?? DEFAULT_SWEEP_LIMIT,
    );
    const expired = await this.#database
      .selectFrom("session_leases as lease")
      .innerJoin("workers as worker", "worker.id", "lease.worker_id")
      .select([
        "worker.id as sandboxId",
        "worker.supervisor_id as supervisorId",
        "worker.boot_id as bootId",
      ])
      .select((eb) => eb.fn.min<Date>("lease.valid_until").as("oldest"))
      // One database-time cutoff per sweep; the scalar InitPlan also permits
      // an indexed range condition instead of a per-row volatile comparison.
      .where("lease.valid_until", "<=", sql<Date>`(select clock_timestamp())`)
      .where("worker.state", "=", "ready")
      .where("lease.released_at", "is", null)
      .groupBy(["worker.id", "worker.supervisor_id", "worker.boot_id"])
      .orderBy("oldest")
      .limit(leaseLimit)
      .execute();
    let expiredAssignments = 0;
    for (const worker of expired) {
      const result =
        await this.#assignmentRetirerFactory(worker).retireExpiredAssignments(leaseLimit);
      expiredAssignments += result.settledAssignments;
    }
    return { connections, expiredAssignments };
  }

  #parseRegistration(value: unknown): SupervisorRegisterMessage {
    let parsed;
    try {
      parsed = parseSupervisorToControlMessage(value);
    } catch {
      throw new SupervisorConnectionManagerError(
        "invalid_registration",
        "Supervisor registration message is invalid",
        false,
      );
    }
    if (parsed.type !== "supervisor.register") {
      throw new SupervisorConnectionManagerError(
        "invalid_registration",
        "Expected a supervisor registration",
        false,
      );
    }
    return parsed;
  }

  #validateRegistrationPolicy(message: SupervisorRegisterMessage): void {
    if (message.payload.supervisorVersion !== this.#expectedSupervisorVersion) {
      throw new SupervisorConnectionManagerError(
        "unsupported_supervisor_version",
        "Supervisor version is not accepted",
        false,
      );
    }
    if (
      message.payload.pi.packageName !== this.#expectedPiPackageName ||
      message.payload.pi.version !== this.#expectedPiVersion
    ) {
      throw new SupervisorConnectionManagerError(
        "unsupported_pi_runtime",
        "Pi runtime is not accepted",
        false,
      );
    }
    if (!message.payload.supportedProtocolVersions.includes(1)) {
      throw new SupervisorConnectionManagerError(
        "unsupported_protocol",
        "Supervisor does not support protocol version 1",
        false,
      );
    }
    const capabilities = new Set(message.payload.capabilities);
    if (this.#requiredCapabilities.some((capability) => !capabilities.has(capability))) {
      throw new SupervisorConnectionManagerError(
        "missing_capability",
        "Supervisor is missing a required capability",
        false,
      );
    }
  }

  #validateAuthority(
    authority: SupervisorTransportAuthority,
    payload: { supervisorId: string; bootId: string; sandboxId?: string },
  ): void {
    this.#validateAuthorityShape(authority);
    if (
      authority.supervisorId !== payload.supervisorId ||
      authority.bootId !== payload.bootId ||
      (payload.sandboxId !== undefined && authority.sandboxId !== payload.sandboxId)
    ) {
      throw new SupervisorConnectionManagerError(
        "unauthorized_supervisor",
        "Supervisor message does not match its authenticated transport",
        false,
      );
    }
  }

  #validateAuthorityShape(authority: SupervisorTransportAuthority): void {
    nonEmpty(authority.supervisorId, "authority.supervisorId");
    requireUuid(authority.bootId, "authority.bootId");
    requireUuid(authority.sandboxId, "authority.sandboxId");
    requireUuid(authority.transportId, "authority.transportId");
  }

  #registrationAcknowledgement(connection: ConnectionRow): SupervisorRegisteredMessage {
    const parsed = parseControlToSupervisorMessage({
      protocolVersion: 1,
      messageId: connection.registered_message_id,
      sentAt: new Date(connection.registered_at).toISOString(),
      type: "supervisor.registered",
      payload: {
        supervisorId: connection.supervisor_id,
        bootId: connection.boot_id,
        connectionId: connection.connection_id,
        selectedProtocolVersion: 1,
        heartbeatIntervalMs: connection.heartbeat_interval_ms,
        heartbeatTimeoutMs: connection.heartbeat_timeout_ms,
        serverTime: new Date(connection.registered_at).toISOString(),
      },
    });
    if (parsed.type !== "supervisor.registered") {
      throw new SupervisorConnectionManagerError(
        "registration_invariant",
        "Stored supervisor registration response is invalid",
        false,
      );
    }
    return parsed;
  }

  #registrationRejection(
    code: string,
    message: string,
    retryable: boolean,
  ): RegistrationTransactionResult {
    return { kind: "rejected", code, message, retryable };
  }

  async #fenceSandbox(
    transaction: Transaction<Database>,
    sandbox: WorkerIdentityRow,
    reason: WorkerRetirementReason,
    now: Date,
  ): Promise<void> {
    const closeReason: SupervisorConnectionCloseReason = reason;
    await transaction
      .updateTable("supervisor_connections")
      .set({ state: "fenced", close_reason: closeReason, closed_at: now })
      .where("worker_id", "=", sandbox.id)
      .where("state", "=", "active")
      .execute();
    if (sandbox.state === "terminated") return;
    if (sandbox.state !== "failed") {
      await transaction
        .updateTable("workers")
        .set({ state: transitionWorker(sandbox.state, "failed"), updated_at: now })
        .where("id", "=", sandbox.id)
        .where("state", "=", sandbox.state)
        .executeTakeFirstOrThrow();
    }
    await transaction
      .insertInto("worker_retirements")
      .values({
        worker_id: sandbox.id,
        supervisor_id: sandbox.supervisor_id,
        boot_id: sandbox.boot_id,
        reason,
        state: "pending",
        attempts: 0,
        available_at: now,
        claim_id: null,
        claim_owner_id: null,
        claim_until: null,
        last_error: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      })
      .onConflict((conflict) => conflict.column("worker_id").doNothing())
      .executeTakeFirst();
  }

  async #expireConnection(connectionId: string): Promise<boolean> {
    const candidate = await this.#database
      .selectFrom("supervisor_connections")
      .select(["worker_id", "supervisor_id"])
      .where("connection_id", "=", connectionId)
      .executeTakeFirst();
    if (candidate === undefined) return false;
    return this.#database.transaction().execute(async (transaction) => {
      await this.#lockHost(transaction, candidate.supervisor_id);
      const sandbox = await transaction
        .selectFrom("workers")
        .select(["id", "supervisor_id", "boot_id", "state", "max_concurrent_sessions"])
        .where("id", "=", candidate.worker_id)
        .forUpdate()
        .executeTakeFirst();
      if (sandbox === undefined) {
        throw new SupervisorConnectionManagerError(
          "supervisor_connection_invariant",
          "Supervisor connection references a missing sandbox",
          false,
        );
      }
      const connection = await transaction
        .selectFrom("supervisor_connections")
        .select(["state", "expires_at"])
        .where("connection_id", "=", connectionId)
        .forUpdate()
        .executeTakeFirst();
      const now = await databaseTime(transaction);
      if (
        connection === undefined ||
        connection.state !== "active" ||
        new Date(connection.expires_at).valueOf() > now.valueOf()
      ) {
        return false;
      }
      await this.#expireLockedConnection(transaction, sandbox, connectionId, now);
      return true;
    });
  }

  async #lockHost(transaction: Transaction<Database>, supervisorId: string): Promise<void> {
    const host = await transaction
      .selectFrom("supervisor_hosts")
      .select("supervisor_id")
      .where("supervisor_id", "=", supervisorId)
      .forUpdate()
      .executeTakeFirst();
    if (!host)
      throw new SupervisorConnectionManagerError(
        "boot_unavailable",
        "Supervisor host is not provisioned",
        false,
      );
  }

  async #bootAuthorized(
    transaction: Transaction<Database>,
    worker: WorkerIdentityRow,
  ): Promise<boolean> {
    return !!(await transaction
      .selectFrom("supervisor_boot_credentials")
      .select("credential_id")
      .where("worker_id", "=", worker.id)
      .where("supervisor_id", "=", worker.supervisor_id)
      .where("boot_id", "=", worker.boot_id)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", sql<Date>`clock_timestamp()`)
      .executeTakeFirst());
  }

  /** Host and Worker are locked: a new Boot or in-flight claim cannot cross this decision. */
  async #canRetainBoot(
    transaction: Transaction<Database>,
    worker: WorkerIdentityRow,
  ): Promise<boolean> {
    if (worker.state !== "ready" || !(await this.#bootAuthorized(transaction, worker)))
      return false;
    const retirement = await transaction
      .selectFrom("worker_retirements")
      .select("worker_id")
      .where("worker_id", "=", worker.id)
      .executeTakeFirst();
    if (retirement) return false;
    // Preserve fresh execution protection, including independent expiry of one
    // Session on a busy Worker. No fresh lease alone is not proof of idleness.
    if (await this.#hasFreshExecution(transaction, worker.id)) return true;
    return !(await transaction
      .selectFrom("session_leases")
      .select("lease_id")
      .where("worker_id", "=", worker.id)
      .where("released_at", "is", null)
      .executeTakeFirst());
  }

  async #expireLockedConnection(
    transaction: Transaction<Database>,
    worker: WorkerIdentityRow,
    connectionId: string,
    now: Date,
  ): Promise<boolean> {
    if (!(await this.#canRetainBoot(transaction, worker))) {
      await this.#fenceSandbox(transaction, worker, "heartbeat_timeout", now);
      return false;
    }
    const expired = await transaction
      .updateTable("supervisor_connections")
      .set({ state: "expired", close_reason: "heartbeat_timeout", closed_at: now })
      .where("connection_id", "=", connectionId)
      .where("state", "=", "active")
      .executeTakeFirst();
    expectOne(expired.numUpdatedRows, "expiring a Supervisor transport");
    return true;
  }

  /** Cold failure path only. Commit expiry before returning the retryable close. */
  async #staleConnection(
    connectionId: string,
    authority: SupervisorTransportAuthority,
  ): Promise<SupervisorConnectionManagerError> {
    const retryable = await this.#database.transaction().execute(async (tx) => {
      await this.#lockHost(tx, authority.supervisorId);
      const worker = await tx
        .selectFrom("workers")
        .select(["id", "supervisor_id", "boot_id", "state", "max_concurrent_sessions"])
        .where("id", "=", authority.sandboxId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !worker ||
        worker.supervisor_id !== authority.supervisorId ||
        worker.boot_id !== authority.bootId
      )
        return false;
      const connection = await tx
        .selectFrom("supervisor_connections")
        .selectAll()
        .where("connection_id", "=", connectionId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !connection ||
        connection.worker_id !== worker.id ||
        connection.boot_id !== worker.boot_id ||
        connection.transport_id !== authority.transportId ||
        connection.control_plane_instance_id !== this.#controlPlaneInstanceId
      )
        return false;
      const now = await databaseTime(tx);
      if (connection.state === "active" && connection.expires_at.valueOf() <= now.valueOf())
        return this.#expireLockedConnection(tx, worker, connectionId, now);
      if (connection.state !== "expired" || !(await this.#canRetainBoot(tx, worker))) return false;
      return !(await tx
        .selectFrom("supervisor_connections")
        .select("connection_id")
        .where("worker_id", "=", worker.id)
        .where("state", "=", "active")
        .executeTakeFirst());
    });
    return new SupervisorConnectionManagerError(
      "stale_connection",
      "Supervisor transport must register again",
      retryable,
    );
  }

  async #hasFreshExecution(
    database: Kysely<Database> | Transaction<Database>,
    sandboxId: string,
  ): Promise<boolean> {
    const lease = await database
      .selectFrom("session_leases")
      .select("lease_id")
      .where("worker_id", "=", sandboxId)
      .where("released_at", "is", null)
      .where("valid_until", ">", sql<Date>`clock_timestamp()`)
      .where(
        "renewed_at",
        ">",
        sql<Date>`clock_timestamp() - ${this.#heartbeatTimeoutMs} * interval '1 millisecond'`,
      )
      .executeTakeFirst();
    return lease !== undefined;
  }

  async #claimRetirement(now: Date): Promise<RetirementClaim | undefined> {
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("worker_retirements")
        .select(["worker_id", "supervisor_id", "boot_id", "attempts"])
        .where((expression) =>
          expression.or([
            expression.and([
              expression("state", "=", "pending"),
              expression("available_at", "<=", now),
            ]),
            expression.and([
              expression("state", "=", "claimed"),
              expression("claim_until", "<=", now),
            ]),
          ]),
        )
        .orderBy("created_at", "asc")
        .orderBy("worker_id", "asc")
        .forUpdate()
        .skipLocked()
        .limit(1)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const claimId = requireUuid(this.#idGenerator(), "generated retirement claimId");
      const attempt = row.attempts + 1;
      const updated = await transaction
        .updateTable("worker_retirements")
        .set({
          state: "claimed",
          attempts: attempt,
          claim_id: claimId,
          claim_owner_id: this.#controlPlaneInstanceId,
          claim_until: new Date(now.valueOf() + this.#retirementClaimDurationMs),
          updated_at: now,
        })
        .where("worker_id", "=", row.worker_id)
        .executeTakeFirst();
      expectOne(updated.numUpdatedRows, "claiming sandbox retirement");
      return {
        identity: {
          supervisorId: row.supervisor_id,
          bootId: row.boot_id,
          sandboxId: row.worker_id,
        },
        claimId,
        attempt,
      };
    });
  }

  async #renewRetirementClaim(claim: RetirementClaim, now: Date): Promise<void> {
    const updated = await this.#database
      .updateTable("worker_retirements")
      .set({
        claim_until: new Date(now.valueOf() + this.#retirementClaimDurationMs),
        updated_at: now,
      })
      .where("worker_id", "=", claim.identity.sandboxId)
      .where("state", "=", "claimed")
      .where("claim_id", "=", claim.claimId)
      .where("claim_owner_id", "=", this.#controlPlaneInstanceId)
      .where("claim_until", ">", now)
      .executeTakeFirst();
    expectOne(updated.numUpdatedRows, "renewing sandbox retirement claim");
  }

  async #completeRetirementClaim(claim: RetirementClaim, now: Date): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const sandbox = await transaction
        .selectFrom("workers")
        .select(["supervisor_id", "boot_id", "state"])
        .where("id", "=", claim.identity.sandboxId)
        .forUpdate()
        .executeTakeFirst();
      if (
        sandbox === undefined ||
        sandbox.supervisor_id !== claim.identity.supervisorId ||
        sandbox.boot_id !== claim.identity.bootId ||
        sandbox.state !== "terminated"
      ) {
        throw new SupervisorConnectionManagerError(
          "retirement_not_confirmed",
          "Sandbox retirement did not reach its durable terminal state",
          false,
        );
      }
      const updated = await transaction
        .updateTable("worker_retirements")
        .set({
          state: "completed",
          claim_id: null,
          claim_owner_id: null,
          claim_until: null,
          last_error: null,
          updated_at: now,
          completed_at: now,
        })
        .where("worker_id", "=", claim.identity.sandboxId)
        .where("state", "=", "claimed")
        .where("claim_id", "=", claim.claimId)
        .where("claim_owner_id", "=", this.#controlPlaneInstanceId)
        .executeTakeFirst();
      expectOne(updated.numUpdatedRows, "completing sandbox retirement claim");
    });
  }

  async #failRetirementClaim(
    claim: RetirementClaim,
    errorCode: string,
    state: "pending" | "blocked",
    now: Date,
  ): Promise<void> {
    const updated = await this.#database
      .updateTable("worker_retirements")
      .set({
        state,
        available_at:
          state === "pending" ? new Date(now.valueOf() + this.#retirementRetryDelayMs) : now,
        claim_id: null,
        claim_owner_id: null,
        claim_until: null,
        last_error: errorCode,
        updated_at: now,
      })
      .where("worker_id", "=", claim.identity.sandboxId)
      .where("state", "=", "claimed")
      .where("claim_id", "=", claim.claimId)
      .where("claim_owner_id", "=", this.#controlPlaneInstanceId)
      .executeTakeFirst();
    expectOne(updated.numUpdatedRows, "releasing sandbox retirement claim");
  }
}
