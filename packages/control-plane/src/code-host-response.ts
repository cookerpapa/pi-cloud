const MAXIMUM_RESPONSE_BYTES = 4 * 1_024 * 1_024;

type RequestError = new (code: string, message: string, retryable: boolean) => Error;

export async function readCodeHostJson(
  response: Response,
  provider: "GitHub" | "GitLab",
  Failure: RequestError,
): Promise<unknown> {
  const prefix = provider.toLowerCase();
  if (!response.ok) {
    await response.body?.cancel();
    throw new Failure(
      `${prefix}_${
        response.status === 401 || response.status === 403
          ? "authorization_failed"
          : response.status === 404
            ? "resource_not_found"
            : "request_failed"
      }`,
      `${provider} request failed`,
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (reader !== undefined) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Failure(
          `${prefix}_response_invalid`,
          `${provider} response exceeded its byte limit`,
          false,
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader?.releaseLock();
  }
  try {
    return length === 0
      ? {}
      : (JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown);
  } catch {
    throw new Failure(`${prefix}_response_invalid`, `${provider} returned invalid JSON`, false);
  }
}
