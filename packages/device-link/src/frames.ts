export const DEVICE_LINK_MAX_BYTES = 5 * 1024 * 1024;
export const DEVICE_LINK_WAIT_MS = 5_000;
export const deviceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const paths = new Map([
  ["/health/ready", "GET"],
  ["/internal/v1/executor/operations", "POST"],
  ["/internal/v1/executor/operations/cancel", "POST"],
  ["/internal/v1/executor/bindings/close", "POST"],
]);
export type DeviceRequest = { id: string; method: string; path: string; body?: unknown };
export type DeviceResponse = { id: string; status: number; body: unknown };
export function isDeviceRequest(value: unknown): value is DeviceRequest {
  const request = value as DeviceRequest | undefined;
  return Boolean(
    request && deviceId.test(request.id) && paths.get(request.path) === request.method,
  );
}
export function isDeviceResponse(value: unknown): value is DeviceResponse {
  const response = value as DeviceResponse | undefined;
  return Boolean(
    response &&
    deviceId.test(response.id) &&
    Number.isInteger(response.status) &&
    response.status >= 200 &&
    response.status <= 599,
  );
}
export const unavailable = (id: string, effect: "not_started" | "unknown"): DeviceResponse => ({
  id,
  status: 503,
  body: { error: { code: "device_link_unavailable", effect } },
});
