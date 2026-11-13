import { PiCloudApiError } from "@pi-cloud/session-client";
import type { Translate } from "./i18n.tsx";

export function errorMessage(error: unknown, t?: Translate): string {
  if (error instanceof PiCloudApiError) return error.message;
  return t?.("error.generic") ?? "请求没有完成，请稍后重试。";
}
