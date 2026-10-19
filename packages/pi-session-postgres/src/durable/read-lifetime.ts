import {
  databaseReadSignal,
  withDatabaseReadSignal,
  isTransientDatabaseReadError,
} from "@pi-cloud/database";

export class NativeReadUnavailableError extends Error {
  readonly code = "native_storage_unavailable";
  readonly retryable = true;
  constructor(cause: unknown) {
    super("Native Session data could not be read", { cause });
  }
}

function transient(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof NativeReadUnavailableError || isTransientDatabaseReadError(error))
    return true;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return error.name === "TimeoutError" || (status !== undefined && status >= 500 && status <= 599);
}

/** Only reads enter this boundary. In particular, never wrap publication or ACK adoption. */
export function nativeRead<T>(
  read: () => Promise<T>,
  signal?: AbortSignal,
  failed?: (error: NativeReadUnavailableError) => void,
): Promise<T> {
  return withDatabaseReadSignal(signal, async () => {
    const active = databaseReadSignal();
    try {
      const value = await read();
      active?.throwIfAborted();
      return value;
    } catch (error) {
      active?.throwIfAborted();
      // A read used to materialize a document copy can be wrapped by native
      // validation. Preserve the unavailable-data cause instead of rejecting input.
      const cause = error instanceof Error && transient(error.cause) ? error.cause : error;
      if (!transient(cause)) throw error;
      const failure =
        cause instanceof NativeReadUnavailableError ? cause : new NativeReadUnavailableError(cause);
      failed?.(failure);
      throw failure;
    }
  });
}
