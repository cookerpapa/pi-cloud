import type { ResourceMeteringEvent, SandboxLifecycleEvent } from "@pi-cloud/protocol";
export type LifecycleAccountingState = {
  source: string;
  epoch: string;
  event: SandboxLifecycleEvent;
  /** Wall-clock rollback must never move the priced boundary backwards. */
  through: string;
};

export function lifecycleInterval(
  source: string,
  epoch: string,
  event: SandboxLifecycleEvent,
  previous?: LifecycleAccountingState,
): { state: LifecycleAccountingState; receipt?: ResourceMeteringEvent } {
  const at = Date.parse(event.observedAt),
    before = previous ? Date.parse(previous.through) : at;
  const end = Math.max(at, before),
    from = before;
  const state: LifecycleAccountingState = {
    source,
    epoch,
    event,
    through: new Date(end).toISOString(),
  };
  let reason: ResourceMeteringEvent["reason"] = event.gapReason;
  if (previous) {
    if (at < before || event.gapReason === "clock_changed") reason = "clock_changed";
    else if (
      previous.source !== source ||
      previous.epoch !== epoch ||
      previous.event.sourceBootId !== event.sourceBootId
    )
      reason = "source_restarted";
    else if (event.gapReason) reason = event.gapReason;
    else if (event.previousSequence !== previous.event.sequence) reason = "collection_unavailable";
    else if (event.incarnation !== previous.event.incarnation) reason = "instance_changed";
    else if (
      event.quantity.cpuMillis !== previous.event.quantity.cpuMillis ||
      event.quantity.memoryBytes !== previous.event.quantity.memoryBytes
    )
      reason = "observation_unavailable";
    else if (end - from > 90_000 || event.state === "unknown" || previous.event.state === "unknown")
      reason = "observation_unavailable";
    else if (previous.event.state !== event.state) reason = "observation_unavailable";
    // Known paused/absent coverage has no compute charge. Keep only the current
    // checkpoint, not a stream of zero-value invoice rows.
    if (!reason && event.state !== "running") return { state };
  }
  // Optional trustworthy provider stop timestamps can close the prior running
  // interval. Cube currently omits this evidence rather than backdating discovery.
  let to = end;
  if (
    previous?.event.state === "running" &&
    ["paused", "absent"].includes(event.state) &&
    event.occurredAt !== null &&
    Date.parse(event.occurredAt) >= from &&
    Date.parse(event.occurredAt) <= end &&
    previous.source === source &&
    previous.epoch === epoch &&
    previous.event.sourceBootId === event.sourceBootId &&
    event.previousSequence === previous.event.sequence &&
    !event.gapReason &&
    previous.event.incarnation === event.incarnation &&
    previous.event.quantity.cpuMillis === event.quantity.cpuMillis &&
    previous.event.quantity.memoryBytes === event.quantity.memoryBytes
  ) {
    to = Date.parse(event.occurredAt);
    reason = undefined;
  }
  return {
    state,
    receipt: {
      version: 1,
      eventId: event.eventId,
      resource: event.resource,
      sourceId: source,
      sourceBootId: event.sourceBootId,
      incarnation: event.incarnation,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      quality: reason ? "unconfirmed" : "confirmed",
      ...(reason ? { reason } : {}),
      state: event.state,
      quantity: previous?.event.quantity ?? event.quantity,
    },
  };
}
