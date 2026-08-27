import type { Database } from "@pi-cloud/database";
import type { Session } from "@earendil-works/pi-agent-core";
import type { Kysely } from "kysely";
import { PostgresRunExecutionAuthority } from "./postgres-execution-authority.ts";
import { PostgresPiSessionRepository } from "./postgres-session-repository.ts";
import type { PostgresPiSessionEntryPayloadCache } from "./session-entry-payload-cache.ts";
import type { PiSessionMutationPublisher } from "./session-mutation.ts";

export type CloudAgentExecutionScope = Readonly<{
  tenantId: string;
  sessionId: string;
  turnId: string;
  runId: string;
}>;

export type OpenPostgresDurableAgentSessionOptions = Readonly<{
  database: Kysely<Database>;
  scope: CloudAgentExecutionScope;
  executionLease: string;
  pollIntervalMs?: number;
  clock?: () => Date;
  entryPayloadCache?: PostgresPiSessionEntryPayloadCache;
  mutationPublisher?: PiSessionMutationPublisher;
}>;

export type PostgresDurableAgentSession = Readonly<{
  session: Session;
  authority: PostgresRunExecutionAuthority;
}>;

export async function synchronizePiSessionProjectionBeforeRead(
  publisher: PiSessionMutationPublisher | undefined,
  authority: Pick<PostgresRunExecutionAuthority, "assertCurrent">,
): Promise<void> {
  await publisher?.synchronize();
  await authority.assertCurrent();
}

/**
 * Opens a Pi Session and the exact same opaque authority used by Session writes
 * and remote Tool effects.
 */
export async function openPostgresDurableAgentSession(
  options: OpenPostgresDurableAgentSessionOptions,
): Promise<PostgresDurableAgentSession> {
  const authority = new PostgresRunExecutionAuthority({
    database: options.database,
    tenantId: options.scope.tenantId,
    sessionId: options.scope.sessionId,
    runId: options.scope.runId,
    turnId: options.scope.turnId,
    executionLease: options.executionLease,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  await authority.assertCurrent();
  authority.start();
  try {
    await synchronizePiSessionProjectionBeforeRead(options.mutationPublisher, authority);
    const repository = new PostgresPiSessionRepository({
      database: options.database,
      tenantId: options.scope.tenantId,
      turnId: options.scope.turnId,
      authority,
      ...(options.entryPayloadCache === undefined
        ? {}
        : { entryPayloadCache: options.entryPayloadCache }),
      ...(options.mutationPublisher === undefined
        ? {}
        : { mutationPublisher: options.mutationPublisher }),
    });
    const session = await repository.openById(options.scope.sessionId);
    return {
      session,
      authority,
    };
  } catch (error: unknown) {
    await authority.close();
    throw error;
  }
}
