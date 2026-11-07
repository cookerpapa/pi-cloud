// Kafka transport and Session Projector faults exercise separate authorities.
// Resource-management outages use run-live-control-plane-outage-check.mjs.
const kafka = process.env.PI_CLOUD_LIVE_KAFKA_BROKER_RESTART_CHECK === "1";
const sessionRuntime = process.env.PI_CLOUD_LIVE_SESSION_RUNTIME_RESTART_CHECK === "1";
if (kafka && sessionRuntime) throw new Error("Select one runtime fault at a time");
if (kafka) {
  await import("./run-live-kafka-broker-restart-check.mjs");
} else if (sessionRuntime) {
  await import("./run-live-cube-handoff-restart-check.mjs");
} else {
  throw new Error(
    "Select PI_CLOUD_LIVE_KAFKA_BROKER_RESTART_CHECK=1 or PI_CLOUD_LIVE_SESSION_RUNTIME_RESTART_CHECK=1 explicitly",
  );
}
