export const MODEL_PURPOSE_HEADER = "x-pi-cloud-model-purpose";
export const MODEL_SESSION_HEADER = "x-picloud-model-session";
export const DEFAULT_MODEL_REQUEST_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MODEL_UPLOAD_MAX_BYTES = 512 * 1024 * 1024;

/** Disposable provider cache identity, deliberately independent of Run/lease.
 * It never grants execution or imports another Conversation's context. */
export async function modelTransportKey(input: {
  tenantId: string;
  sessionId: string;
  conversationId: number;
  credentialBindingId: string;
  credentialBindingVersion: number;
  purpose: "agent" | "context_maintenance";
}): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        input.tenantId,
        input.sessionId,
        input.conversationId,
        input.credentialBindingId,
        input.credentialBindingVersion,
        input.purpose,
      ]),
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
