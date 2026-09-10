export type ControlPlaneStoreErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "idempotency_conflict"
  | "tenant_quota_exceeded"
  | "capacity_exhausted"
  | "control_plane_misconfigured";

export class ControlPlaneStoreError extends Error {
  readonly code: ControlPlaneStoreErrorCode;

  constructor(code: ControlPlaneStoreErrorCode, message: string) {
    super(message);
    this.name = "ControlPlaneStoreError";
    this.code = code;
  }
}
