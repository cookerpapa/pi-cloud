import { parseModelSamplingIdentity, type ModelSamplingIdentity } from "./model-sampling.ts";

/** Private Runner -> local Model Gateway transport, not native history. */
export type ModelSocketRequest = {
  protocolVersion: 1;
  sampling: ModelSamplingIdentity;
  /** Serialized native response.create. Metadata stays outside Pi's prefix comparison. */
  request: string;
};

export function encodeModelSocketRequest(sampling: ModelSamplingIdentity, request: string): string {
  return (
    JSON.stringify({
      protocolVersion: 1,
      sampling: parseModelSamplingIdentity(sampling),
    }) +
    "\n" +
    request
  );
}

export function parseModelSocketRequest(bytes: string): ModelSocketRequest {
  const separator = bytes.indexOf("\n");
  if (separator < 0 || separator > 4096) throw new TypeError("Invalid model WebSocket header");
  const value = JSON.parse(bytes.slice(0, separator)) as Partial<ModelSocketRequest>;
  if (!value || value.protocolVersion !== 1 || !value.sampling)
    throw new TypeError("Invalid model WebSocket envelope");
  return {
    protocolVersion: 1,
    sampling: parseModelSamplingIdentity(value.sampling),
    request: bytes.slice(separator + 1),
  };
}
