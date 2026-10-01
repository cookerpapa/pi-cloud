// The two failures have different authorities after the publication cutover.
if (process.env.PI_CLOUD_LIVE_KAFKA_BROKER_RESTART_CHECK === "1") {
  await import("./run-live-kafka-broker-restart-check.mjs");
} else {
  await import("./run-live-cube-handoff-restart-check.mjs");
}
