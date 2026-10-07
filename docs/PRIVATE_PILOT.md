# Private-use pilot

The architecture review is complete. This is the next evidence gate, not another
architecture rewrite or a claim of fleet capacity. The owner asked to repair the
readiness issues first; **the pilot has not started**.

Use one ordinary working week and 10–20 real tasks. Keep the deployed revision,
guest/completion identities and model recorded. Use GPT-6 Luna as the baseline
model unless the owner chooses otherwise. Include repository changes, frontend
preview with repeated screenshots, image attachments, later Session resumption,
and natural Stop/follow-up/Steer use. Do not invent disruptive failures in a task
whose output the owner needs; controlled faults retain their separate test suite.

## Per-task evidence

Record a short task label (no source/transcript), Session/Run IDs, start/end time,
whether the intended result was achieved, operator interventions, and any incident.
Count retries caused by the model/provider separately from infrastructure failures.
For a slow task, record admission-to-first-visible-event, provider waiting time,
Tool takeover/result time and projection lag using the existing metrics/logs. Keep
the evidence private. For this small sample, report median and maximum with the
sample count, not a statistically authoritative p95 or fleet throughput claim.

Initial acceptance targets for this bounded trial:

| Concern | Passing evidence |
| --- | --- |
| Actual usefulness | At least 8 of the first 10 ordinary tasks reach the owner's intended outcome; record model failures even if infra stayed healthy. |
| Operator burden | At most one task in 10 requires manual service/database intervention. Editing code or changing a prompt is not an operator intervention. |
| Conversation assets | No acknowledged input/history/image lost, no wrong-session output, no duplicate external effect caused by recovery. |
| Interruption | Stop returns unconsumed inputs with attachments, allows a fresh request, and never reports unknown physical completion as confirmed. |
| Visibility | Every accepted task can be located and its current state explained; unexplained silent periods over 30 seconds are investigated against provider/Tool/projection evidence. This is not a model latency SLA. |
| Recovery capability | The isolated asset restore drill passes. The owner has explicitly deferred backups of the current disposable data; an off-machine copy is not a gate for this pilot. |

Any asset loss, cross-session mix-up or unintended effect replay stops the pilot
for a bounded repair. Repeated manual repair is a failed readiness outcome even
when a subsequent demonstration succeeds. At the end, choose the next backlog
item from observed task failures or measured bottlenecks. Do not add a scheduler,
cache, queue or Cube redesign simply because one might become useful at scale.

## Backup operating boundary

The owner explicitly chose **no backup of the current data** on October 7; no
backup schedule or remote destination is enabled. The current data is disposable.
The [cold asset procedure](ASSET_RECOVERY.md) remains available on demand.
If the owner later entrusts valuable history to the system, agree an RPO/retention
policy and off-machine destination first. A suggested small-use starting point is
daily verified backup plus a pre-upgrade copy, with a measured 30-minute restore
target. These are future operating targets, not existing guarantees or scheduled
work. A bundle left on the PiCloud host is not host-loss protection.

This pilot does not establish multi-node HA, fleet scheduling economics, a
fresh-machine installation, or preservation of Workspace files/background services.
Those remain independent acceptance items.
