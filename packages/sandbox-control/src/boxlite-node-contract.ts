import type { GuestRuntimeInstance } from "./guest-runtime-client.ts";

export type BoxLiteProcessEvidence = Readonly<{
  hostBootId: string;
  processes: readonly { pid: number; startTime: string }[];
}>;
export type BoxLiteInstance = GuestRuntimeInstance &
  Readonly<{
    connection?: BoxLiteProcessEvidence;
    attachment: {
      volumeId: string;
      namespace: string;
      sandboxId: string;
      metadata: unknown;
      hostPath: string;
    };
  }>;
export type BoxLiteImageProfile = Readonly<{
  image: string;
  cpus: number;
  memoryMiB: number;
  diskGiB: number;
}>;
export const BOXLITE_NODE_PATH = "/internal/v1/boxlite";
export const BOXLITE_NODE_PROTOCOL_VERSION = 2;
