// Expected baseline exit 1: actual health pump does not contain target-enumeration failure.
import { RuntimeHealthMonitor } from "../packages/sandbox-control/src/runtime-health-monitor.ts";
new RuntimeHealthMonitor({
  targets() {
    throw new Error("review_detached_runtime_handle");
  },
  inventory: async () => new Map(),
  onError() {
    console.log("contained_failure");
  },
});
setTimeout(() => console.log("survived"), 1500);
