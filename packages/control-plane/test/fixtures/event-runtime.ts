import { SessionEventHub } from "@pi-cloud/runtime-core/session-event-hub";
import type { ControlPlaneEventRuntime } from "../../src/control-plane.module.ts";

/** API-only fixtures have no producer or durability claim. */
export function emptyEventRuntime(): ControlPlaneEventRuntime {
  return {
    eventHub: new SessionEventHub(),
    eventStore: {
      snapshot: () => ({ canonicalThroughSequence: 0, highWaterMark: 0, events: [] }),
    },
  };
}
