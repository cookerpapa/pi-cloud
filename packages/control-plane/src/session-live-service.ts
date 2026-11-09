import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { withDatabaseReadSignal, type Database } from "@pi-cloud/database";
import { parseUuidPathParameter } from "@pi-cloud/protocol";
import {
  INTERNAL_SESSION_EVENTS_PATH,
  SessionEventStream,
} from "@pi-cloud/runtime-core/session-event-stream";
import { ConversationReader } from "./conversation-reader.ts";

/** A read-only stream from the single projection owner. The public API has
 * already authenticated the tenant; no browser credential crosses this port. */
export class SessionLiveService {
  constructor(
    readonly options: {
      database: Kysely<Database>;
      stream: SessionEventStream;
      token: string;
    },
  ) {}

  install(server: FastifyInstance): void {
    const hash = (value: string) => createHash("sha256").update(value).digest();
    const expected = hash(`Bearer ${this.options.token}`);
    server.get(`${INTERNAL_SESSION_EVENTS_PATH}/:tenantId/:sessionId`, async (request, reply) => {
      if (!timingSafeEqual(expected, hash(request.headers.authorization ?? "")))
        return reply.code(401).send();
      let tenantId: string, sessionId: string;
      try {
        const parameters = request.params as { tenantId: unknown; sessionId: unknown };
        tenantId = parseUuidPathParameter(parameters.tenantId, "tenantId");
        sessionId = parseUuidPathParameter(parameters.sessionId, "sessionId");
      } catch {
        return reply.code(400).send();
      }
      const abort = new AbortController();
      const close = () => abort.abort();
      reply.raw.once("close", close);
      let stream: Awaited<ReturnType<SessionEventStream["open"]>> | undefined;
      try {
        const owner = await this.options.stream.owner(tenantId, sessionId);
        if (owner)
          return reply
            .code(307)
            .header(
              "location",
              new URL(`${INTERNAL_SESSION_EVENTS_PATH}/${tenantId}/${sessionId}`, owner).toString(),
            )
            .send();
        stream = await withDatabaseReadSignal(abort.signal, () =>
          this.options.stream.open({
            tenantId,
            sessionId,
            loadCanonical: () =>
              new ConversationReader(this.options.database, tenantId).getConversationView(
                sessionId,
              ),
          }),
        );
        if (abort.signal.aborted) {
          stream.close();
          return;
        }
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        });
        reply.raw.flushHeaders();
        await stream.pipe(reply.raw);
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      } catch {
        if (reply.raw.headersSent) reply.raw.destroy();
        else if (!reply.raw.destroyed) await reply.code(503).send();
      } finally {
        stream?.close();
        reply.raw.off("close", close);
        abort.abort();
      }
    });
  }
}
