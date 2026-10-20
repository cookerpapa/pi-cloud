import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { Database, SessionUploadTable } from "@pi-cloud/database";
import {
  type UploadContent,
  USER_UPLOAD_DRAFT_TTL_MS,
  parseUserUpload,
  uploadFileName,
  uploadRelativePath,
  type UserUpload,
  type WorkspaceUploadRequest,
  parseImageAttachmentReference,
} from "@pi-cloud/protocol";
import type {
  ImageAttachmentStore,
  ImageAttachmentSource,
  ImageUploadStore,
} from "@pi-cloud/session-attachments";
import { forkUpload, verifiedUpload, sniffUpload } from "./workspace-upload-stream.ts";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";
import type { UploadInputPin } from "./upload-input-pins.ts";
import { withDatabaseReadSignal } from "@pi-cloud/database/client";

export interface WorkspaceUploader {
  uploadWorkspaceFile(
    request: WorkspaceUploadRequest,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<{ relativePath: string; byteLength: number; sha256: string }>;
}
function conflict(message: string): never {
  throw new ControlPlaneStoreError("conflict", message);
}
function imageMime(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return undefined;
}
export function uploadResource(row: Selectable<SessionUploadTable>): UserUpload {
  return parseUserUpload({
    id: row.id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    name: row.name,
    path: row.path,
    mimeType: row.mime_type,
    byteLength: Number(row.byte_length),
    sha256: row.sha256,
    ...(row.image_reference ? { image: parseImageAttachmentReference(row.image_reference) } : {}),
  });
}

/** Durable upload metadata and input binding; byte placement stays behind the
 * Workspace port and image decoding stays in Cube. No transaction spans HTTP. */
export class WorkspaceUploadService {
  readonly #active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  constructor(
    readonly options: {
      database: Kysely<Database>;
      uploader?: WorkspaceUploader;
      images?: ImageAttachmentStore & ImageUploadStore & ImageAttachmentSource;
    },
  ) {}

  async upload(
    tenantId: string,
    actorUserId: string,
    sessionId: string,
    id: string,
    nameValue: string,
    content: UploadContent,
    signal?: AbortSignal,
  ): Promise<UserUpload> {
    let name: string;
    try {
      name = uploadFileName(nameValue);
    } catch {
      throw new ControlPlaneStoreError("invalid_request", "Upload filename is invalid");
    }
    if (
      !Number.isSafeInteger(content.byteLength) ||
      content.byteLength < 1 ||
      !/^[0-9a-f]{64}$/.test(content.sha256)
    )
      throw new ControlPlaneStoreError("invalid_request", "Invalid upload identity");
    if (!this.options.uploader)
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Workspace uploads are unavailable",
      );
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const source = await sniffUpload(verifiedUpload(content, combined)).catch(() => {
      throw new ControlPlaneStoreError("invalid_request", "Upload stream failed its content check");
    });
    try {
      const mimeType = imageMime(source.prefix);
      if (!mimeType && /\.(png|jpe?g|webp|gif|bmp|avif|heic)$/i.test(name))
        throw new ControlPlaneStoreError(
          "invalid_request",
          "Visual input supports PNG, JPEG and WebP images",
        );
      if (mimeType && !this.options.images)
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Image attachment storage is unavailable",
        );
      const sha256 = content.sha256,
        claimToken = randomUUID();
      const db = this.options.database;
      const claimed = await db.transaction().execute(async (tx) => {
        const session = await tx
          .selectFrom("sessions as s")
          .innerJoin("workspaces as w", (join) =>
            join.onRef("w.tenant_id", "=", "s.tenant_id").onRef("w.id", "=", "s.workspace_id"),
          )
          .select([
            "s.workspace_id",
            "s.pi_session_id",
            "s.working_directory",
            "s.execution_mode",
            "s.development_environment_id",
            "s.created_by_user_id",
          ])
          .where("s.id", "=", sessionId)
          .where("s.tenant_id", "=", tenantId)
          .where("s.pruned_at", "is", null)
          .where("s.session_kind", "=", "conversation")
          .where("w.deleted_at", "is", null)
          .forNoKeyUpdate("s")
          .executeTakeFirst();
        if (!session)
          throw new ControlPlaneStoreError("not_found", "Conversation Workspace is unavailable");
        if (
          session.execution_mode === "development_environment" &&
          (!session.development_environment_id || session.created_by_user_id !== actorUserId)
        )
          throw new ControlPlaneStoreError(
            "not_found",
            "Development environment is not owned by this user",
          );
        const existing = await tx
          .selectFrom("session_uploads")
          .selectAll()
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();
        if (existing) {
          if (
            existing.tenant_id !== tenantId ||
            existing.session_id !== sessionId ||
            existing.workspace_id !== session.workspace_id ||
            existing.working_directory !== session.working_directory ||
            existing.name !== name ||
            existing.sha256 !== sha256 ||
            Number(existing.byte_length) !== content.byteLength
          )
            conflict(
              "Upload identity was already used for different content or a different Workspace",
            );
          if (existing.state === "ready") return { session, ready: uploadResource(existing) };
          const updated = await tx
            .updateTable("session_uploads")
            .set({
              state: "uploading",
              claim_token: claimToken,
              lease_expires_at: sql`clock_timestamp() + interval '2 minutes'`,
              expires_at: sql`clock_timestamp() + ${USER_UPLOAD_DRAFT_TTL_MS} * interval '1 millisecond'`,
            })
            .where("id", "=", id)
            .where((eb) =>
              eb.or([
                eb("state", "=", "failed"),
                eb("lease_expires_at", "<=", sql<Date>`clock_timestamp()`),
              ]),
            )
            .returning("id")
            .executeTakeFirst();
          if (!updated) conflict("Upload is already in progress");
        } else {
          await tx
            .insertInto("session_uploads")
            .values({
              id,
              tenant_id: tenantId,
              session_id: sessionId,
              pi_session_id: session.pi_session_id,
              workspace_id: session.workspace_id,
              actor_user_id: actorUserId,
              working_directory: session.working_directory,
              name,
              path: posix.join(session.working_directory, uploadRelativePath(id, name)),
              mime_type: mimeType ?? "application/octet-stream",
              byte_length: content.byteLength,
              sha256,
              state: "uploading",
              claim_token: claimToken,
              lease_expires_at: sql`clock_timestamp() + interval '2 minutes'`,
              image_reference: null,
              expires_at: sql`clock_timestamp() + ${USER_UPLOAD_DRAFT_TTL_MS} * interval '1 millisecond'`,
            })
            .execute();
        }
        return { session };
      });
      if (claimed.ready) {
        // A declared digest identifies the retry; it is not proof of the bytes.
        // Verify replays too, without repeating placement or buffering the file.
        try {
          for await (const _chunk of source.chunks) combined.throwIfAborted();
        } catch {
          throw new ControlPlaneStoreError("conflict", "Upload retry content changed");
        }
        return claimed.ready;
      }
      let renewal = Promise.resolve();
      let renewing = false;
      const activeKey = `${tenantId}:${id}:${claimToken}`;
      const finished = Promise.withResolvers<void>();
      this.#active.set(activeKey, { abort: controller, done: finished.promise });
      const timer = setInterval(() => {
        if (renewing) return;
        renewing = true;
        renewal = db
          .updateTable("session_uploads")
          .set({
            lease_expires_at: sql`clock_timestamp() + interval '2 minutes'`,
            expires_at: sql`clock_timestamp() + ${USER_UPLOAD_DRAFT_TTL_MS} * interval '1 millisecond'`,
          })
          .where("id", "=", id)
          .where("claim_token", "=", claimToken)
          .where("state", "=", "uploading")
          .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
          .returning("id")
          .executeTakeFirst()
          .then((row) => {
            if (!row) controller.abort(new Error("Upload claim expired"));
          })
          .catch((error) => controller.abort(error))
          .finally(() => {
            renewing = false;
          });
      }, 30_000);
      timer.unref();
      let fork: ReturnType<typeof forkUpload> | undefined;
      try {
        combined.throwIfAborted();
        const session = claimed.session;
        const machine =
          session.execution_mode === "development_environment"
            ? {
                environmentId: session.development_environment_id!,
                userId: actorUserId,
                directory: session.working_directory,
              }
            : undefined;
        if (
          !machine &&
          session.working_directory !== "/workspace" &&
          !session.working_directory.startsWith("/workspace/")
        )
          conflict("Workspace root is invalid");
        const request: WorkspaceUploadRequest = {
          uploadProtocolVersion: 2,
          byteLength: content.byteLength,
          type: "workspace.upload_file",
          requestId: randomUUID(),
          uploadId: id,
          claimToken,
          tenantId,
          workspaceId: session.workspace_id,
          sessionId,
          name,
          sha256,
          rootPath: machine
            ? ""
            : session.working_directory.slice("/workspace".length).replace(/^\//, ""),
          ...(machine ? { machine } : {}),
        };
        if (mimeType) fork = forkUpload(source.chunks, combined);
        const transfer = this.options.uploader.uploadWorkspaceFile(
          request,
          fork?.workspace ?? source.chunks,
          combined,
        );
        const archival = mimeType
          ? this.options.images!.putStream(
              { tenantId, uploadId: id, claimToken },
              { ...content, chunks: fork!.image },
              mimeType,
              combined,
            )
          : Promise.resolve(undefined);
        // Join both effects on failure before releasing the claim. The sibling
        // cannot keep publishing after a new retry takes ownership.
        const results = await Promise.allSettled(
          [transfer, archival].map((promise) =>
            promise.catch((error) => {
              controller.abort(error);
              throw error;
            }),
          ),
        );
        for (const result of results) if (result.status === "rejected") throw result.reason;
        const receipt = (results[0] as PromiseFulfilledResult<Awaited<typeof transfer>>).value;
        const image = (results[1] as PromiseFulfilledResult<Awaited<typeof archival>>).value;
        if (
          receipt.sha256 !== sha256 ||
          receipt.byteLength !== content.byteLength ||
          receipt.relativePath !== uploadRelativePath(id, name)
        )
          throw new Error("Workspace upload receipt changed identity");
        combined.throwIfAborted();
        const row = await db.transaction().execute(async (tx) => {
          if (image) {
            const { rows } = await sql<{ id: string }>`select id from session_image_objects
            where tenant_id=${tenantId}::uuid and id=${image.id}::uuid and state='ready'
            for update`.execute(tx);
            if (!rows.length) conflict("Image attachment expired before the upload completed");
          }
          return tx
            .updateTable("session_uploads as u")
            .set({
              state: "ready",
              image_id: image?.id ?? null,
              image_reference: image ? { ...image } : null,
            })
            .where("u.id", "=", id)
            .where("u.claim_token", "=", claimToken)
            .where("u.state", "=", "uploading")
            .where("u.lease_expires_at", ">", sql<Date>`clock_timestamp()`)
            .where(
              sql<boolean>`exists(select 1 from sessions s join workspaces w on w.id=s.workspace_id and w.tenant_id=s.tenant_id
          where s.id=u.session_id and s.tenant_id=u.tenant_id and s.workspace_id=u.workspace_id
            and s.working_directory=u.working_directory and s.pruned_at is null and w.deleted_at is null)`,
            )
            .returningAll()
            .executeTakeFirst();
        });
        if (!row) conflict("Upload authorization expired or the Workspace changed");
        return uploadResource(row);
      } catch (error) {
        await db
          .updateTable("session_uploads")
          .set({ state: "failed" })
          .where("id", "=", id)
          .where("claim_token", "=", claimToken)
          .where("state", "=", "uploading")
          .execute();
        if (error instanceof ControlPlaneStoreError) throw error;
        throw new ControlPlaneStoreError(
          "conflict",
          "File upload did not complete; retry the upload",
        );
      } finally {
        clearInterval(timer);
        await renewal;
        controller.abort();
        fork?.close();
        this.#active.delete(activeKey);
        finished.resolve();
      }
    } finally {
      controller.abort();
      await source.close();
    }
  }

  async remove(tenantId: string, sessionId: string, id: string): Promise<void> {
    const removed = await this.options.database.transaction().execute(async (tx) => {
      await tx
        .selectFrom("session_uploads")
        .select("id")
        .where("id", "=", id)
        .where("tenant_id", "=", tenantId)
        .where("session_id", "=", sessionId)
        .forUpdate()
        .execute();
      // Fresh statement after the admission lock: pins may have committed while
      // this remover was waiting, without modifying the upload row itself.
      return tx
        .deleteFrom("session_uploads")
        .where("id", "=", id)
        .where("tenant_id", "=", tenantId)
        .where("session_id", "=", sessionId)
        .where("accepted_at", "is", null)
        .where(
          sql<boolean>`not exists(select 1 from session_upload_pins p where p.upload_id=session_uploads.id)`,
        )
        .returning("id")
        .execute();
    });
    if (removed.length) {
      const pending = [...this.#active].filter(([key]) => key.startsWith(`${tenantId}:${id}:`));
      for (const [, item] of pending) item.abort.abort(new Error("Upload draft removed"));
      await Promise.all(pending.map(([, item]) => item.done));
    }
  }
  async withImage<T>(
    tenantId: string,
    sessionId: string,
    id: string,
    consume: (
      image: import("@pi-cloud/protocol").ImageAttachmentReference,
      chunks: AsyncIterable<Uint8Array>,
      signal: AbortSignal,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const row = await withDatabaseReadSignal(signal, () =>
      this.options.database
        .selectFrom("session_uploads")
        .selectAll()
        .where("id", "=", id)
        .where("tenant_id", "=", tenantId)
        .where("session_id", "=", sessionId)
        .where("state", "=", "ready")
        .executeTakeFirst(),
    );
    signal?.throwIfAborted();
    if (!row?.image_reference || !this.options.images)
      throw new ControlPlaneStoreError("not_found", "Image attachment is unavailable");
    const image = parseImageAttachmentReference(row.image_reference);
    return this.options.images.withStream(
      tenantId,
      image,
      (chunks, active) => consume(image, chunks, active),
      signal,
    );
  }
}

/** Used under the existing Session/input transaction; an upload may be reused
 * by later messages in its same conversation, including restored queued drafts. */
export async function bindInputUploads(
  tx: Transaction<Database>,
  input: {
    tenantId: string;
    sessionId: string;
    workspaceId: string;
    workingDirectory: string;
    ids: readonly string[];
    pin?: UploadInputPin;
  },
): Promise<UserUpload[]> {
  if (!input.ids.length) return [];
  if (new Set(input.ids).size !== input.ids.length)
    throw new ControlPlaneStoreError("invalid_request", "Invalid input attachment list");
  const rows = await tx
    .selectFrom("session_uploads")
    .selectAll()
    .where("tenant_id", "=", input.tenantId)
    .where("session_id", "=", input.sessionId)
    .where("workspace_id", "=", input.workspaceId)
    .where("working_directory", "=", input.workingDirectory)
    .where("id", "in", input.ids)
    .where("state", "=", "ready")
    .where((eb) =>
      eb.or([
        eb("accepted_at", "is not", null),
        eb("expires_at", ">", sql<Date>`clock_timestamp()`),
        sql<boolean>`exists(select 1 from session_upload_pins p where p.upload_id=session_uploads.id)`,
      ]),
    )
    .orderBy("id")
    .forUpdate()
    .execute();
  if (rows.length !== input.ids.length)
    conflict("An attachment is unavailable or belongs to another conversation or Workspace");
  const map = new Map(rows.map((row) => [row.id, uploadResource(row)]));
  const uploads = input.ids.map((id) => map.get(id)!);
  if (input.pin) {
    const p = input.pin;
    await sql`insert into session_upload_pins(pin_id,upload_id,tenant_id,pi_session_id,
      conversation_id,run_id,writer_id,kind,operation_id,fingerprint) values
      ${sql.join(
        input.ids.map(
          (id) => sql`(${p.id}::uuid,${id}::uuid,${input.tenantId}::uuid,
        ${p.piSessionId},${p.conversationId},${p.runId}::uuid,${p.writerId}::uuid,
        ${p.kind},${p.operationId},${p.fingerprint})`,
        ),
      )}`.execute(tx);
  } else {
    // Initial Run and its upload binding are committed in the same transaction.
    await tx
      .updateTable("session_uploads")
      .set({ accepted_at: sql`coalesce(accepted_at,clock_timestamp())` })
      .where("tenant_id", "=", input.tenantId)
      .where("id", "in", input.ids)
      .execute();
  }
  return uploads;
}
