# Approved empty-environment reset — 2026-09-10

The user authorized removing an unused Tempo node's data and clearing PiCloud
history. This was offline maintenance, not a schema migration or a new runtime
compatibility path. Application code remains the deployed `7acfeefd`.

## Scope and preservation

- Removed Tempo chain databases/static files/consensus state, about 271 GiB.
  Small node keys and startup configuration were retained.
- Cleared PiCloud's 52 Sessions, 48 Projects/Workspaces, 88 historical Runs,
  native Session logs, Tool/event/model-use history and 24 development-machine
  records. The one non-released machine was released first through its service.
- Preserved 35 user identities, 16 password credentials, API/web authentication,
  model routes, provider account files, platform settings and configured code-host
  integrations. Fifteen preserved-table fingerprints matched immediately after
  reset. After authenticated smoke requests, fourteen still matched exactly;
  the API-credential table retained its count and received normal last-use audit
  updates. No credential was rotated.
- Did not remove unrelated repositories, datasets, Conda environments or DSH
  application data. Current Cube templates and deployment secrets were retained.

## Physical cleanup and findings

Workers/Web were stopped before cleanup. Actual Cube instances and guest
hypervisor processes were absent. Three PiCloud Volumes nevertheless had stale
node refcounts of one. After verifying no instances, active snapshot bindings or
mounts, only those three counters were corrected; deletion then went through
Cube's native Volume API and plugin. All 48 Workspace volumes were confirmed
absent and their PG storage-purge markers completed before history truncation.

Twenty-one old PiCloud templates failed normal deletion because replica/job
locators held obsolete Pod IPs. Their stable node identity matched the one current
physical node. Only discarded-template locators were corrected to that node's
current address, then all 21 were deleted through the native API. The four
configured templates and four rootfs artifacts remain. Nineteen additional local
rootfs directories had no remaining artifact/template/runtime reference and were
removed; local rootfs storage fell from roughly 47 GiB to 4.2 GiB.

Cube's standalone MySQL had no replica status or binlog-dump clients. Its old
binary logs occupied about 112.8 GiB. Logs were rotated, then purged through
[MySQL's native PURGE BINARY LOGS](https://dev.mysql.com/doc/refman/8.0/en/purge-binary-logs.html)
up to, but excluding, the new current log. Database files were not manually
unlinked and GTID/execution state was not reset. The original 30-day expiration
setting was **not changed**; renewed accumulation requires a retention-policy
decision, not another assertion that this cleanup fixed logging growth.

The mounted Cube XFS loop filesystem was trimmed with
[fstrim](https://man7.org/linux/man-pages/man8/fstrim.8.html), not raw-device
discard. The 64-GiB virtual capacity was retained while unused backing-file
extents were reclaimed. Reported trim bytes are potential discard, not a claim
that the Windows VHDX shrank by that amount.

## Logical reset and recovery

All PiCloud writers/projectors were stopped. History/resource tables were
truncated together in one PG transaction **without CASCADE**; an unexpected
dependency from a preserved table would abort. Sandbox Domain assignment counts
were reset. Worker boot volumes were recreated so old journals could not restore
retired execution identities.

All six retired accepted-fact topics and the current execution-log topic were
removed, together with the inactive Projector group. After restart only the new,
empty `pi-cloud.execution-log.v7` and Kafka's internal consumer-offset topic
remain. Current topic configuration retains 32 partitions. Historical PiCloud
backups, retired runtime state and provider error logs were also removed;
provider account files and required service configuration were not.

## Verification and final state

An initial probe omitted explicit model selection and used the bootstrap
deterministic fixture; its marker assertion failed and was not counted as a real
model test. The corrected probe selected GPT-5.6 Sol explicitly, matching the Web
flow. Two real Runs passed: the second recalled the first marker and executed a
Python assertion through Bash/Cube. Three real sampling calls recorded 11,379
input, 98 output and 17,152 cache-read tokens. Observed Run completion times were
4.874 s and 15.870 s; these are not TTFT or capacity benchmarks.

All probe resources, records and events were then removed by another quiescent
reset, followed by a clean restart. Final checks:

- 35 users retained; Sessions, Projects, Workspaces, Runs, native Session log
  rows and development machines all zero;
- zero Cube instances and Volumes; four current templates/rootfs artifacts;
- current Kafka topic has zero records; retired topics are absent;
- all 16 running PiCloud services healthy;
- Web and authenticated identity/conversation/Workspace/machine APIs return 200;
- private maintenance scripts, inventory and temporary kubeconfig removed.

WSL available space rose from about 227 GiB to **722 GiB (48.9%)**. This is an
application/storage cleanup, not a forensic secure erase. Deleted application
history and local backups are intentionally no longer available for rollback.
