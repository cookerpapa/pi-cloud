export type ControlPlaneStoreErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "idempotency_conflict"
  | "tenant_quota_exceeded"
  | "capacity_exhausted"
  | "development_environment_creation_pending"
  | "input_delivery_unavailable"
  | "control_plane_misconfigured";

export class ControlPlaneStoreError extends Error {
  readonly code: ControlPlaneStoreErrorCode;

  constructor(
    code: ControlPlaneStoreErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ControlPlaneStoreError";
    this.code = code;
  }
}
