export class NativeSessionError extends Error {
  constructor(
    readonly code: "not_found" | "storage" | "already_exists" | "invalid_conversation",
    message: string,
  ) {
    super(message);
    this.name = "NativeSessionError";
  }
}
