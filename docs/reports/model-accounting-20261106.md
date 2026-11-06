# Model metering and statements delivery — 2026-11-06

The ADR-0297 model-only slice is deployed and accepted. Application Helm is 145,
infrastructure Helm is 112, and PG schema is `210_model_metering`.
The host release is `model-accounting-20261106-r4` (`65db3eba`); the provider
correction is `model-metering-zero-20261106-r2` (`f705e2ff`). Later commits improve
the acceptance drivers/documentation, not the serving execution protocol.

## Delivered behavior

Worker Model Gateway and the image caller supply fresh accounting ownership on
each HTTP invocation. CPA execution UUIDs distinguish provider attempts, including
fallback. A synchronous capture port writes bounded receipts to the existing
provider volume before asynchronous usage dispatch. PG acknowledgement permits
source collection; duplicate and conflicting delivery have separate outcomes.

PG owns request attribution, immutable usage and price versions. Rates separately
describe customer quotes and upstream estimates, with explicit failed-attempt
policy and exact integer trillionths of currency. New prices take effect in the
future; an identical lost-response retry returns the original version, even after
that effective time. Existing amounts are not recomputed on receipt retries.

The account menu exposes **Model costs**, with date/model/Session filters, bounded
pagination, category totals and current-page export. The authenticated API also
streams a selected range as NDJSON. Missing receipts and unsupported/missing rates
remain visible. No real tariffs were assigned to the owner's accounts and no
wallet, payment collection or Sandbox charging was enabled. See
[the contract and operator API](../MODEL_BILLING.md).

## Verification

- All workspace type checks, Web build, public protocol/API tests, relevant Worker
  and Control Plane contracts, Helm/distributed preflight, installation, runtime
  policy and Docker-input checks passed. PostgreSQL tests cover duplicate/changed
  identities, out-of-order arrival, transaction rollback, tenant isolation,
  missing usage, stable pagination, immutable rates and exact amounts.
- Go race tests cover source capture before the asynchronous queue, copied request
  identity after Gin request disposal, capacity recovery, lost acknowledgements,
  refused unrecordable admission and an unclean child-process exit. Native Pi/
  private Responses tests cover reused connections and fallback attribution.
  The complete provider server builds successfully.
- Real browser checks cover statement status/amounts, pagination, filters and the
  deployed account-menu entry. Actual authenticated NDJSON export was parsed and
  matched to the receipt.
- Seven newly deployed host images and the subsequent provider image passed the
  unchanged zero-fixable-HIGH/CRITICAL policy. The six retained Cube/Guest artifacts
  retain their original source/image evidence; they were not relabelled as updated.

## Live results

| Check | Result |
| --- | --- |
| Receiver outage and provider restart | With the Control Plane stopped, a real Luna request completed. The provider was replaced before the receiver returned. Four durable receipts then arrived in PG. Two additional deliveries did not add usage or amounts. |
| Priced owned fixture | 20 input + 7 output tokens at explicitly configured fixture rates yielded `55000000` trillionths, or USD 0.000055. This is a test tariff, not a model price or actual debit. |
| Cross-Worker continuation | Two different Workers continued one physical Session. Six model invocations/executions belonged to the correct two Runs, with zero unconfirmed invocations. Each Run executed two real Cube Bash calls and recalled the retained image. |
| Image transport retained | The 2,317,347-byte PNG cold request used a 3,114,206-byte decoded body. The next Worker's first upstream payload was 24,104 bytes; its whole three-request Run sent 89,296 provider-interface bytes, including internal accounting traffic. |
| Native child | Three model invocations were attributed to the root Run and its two distinct native/public Conversation identities. The child executed and returned normally. |
| Image generation | One `gpt-image-2` invocation retained its Tool operation identity. Its 20 input + 343 output tokens were confirmed; pricing remained explicitly unsupported/unpriced. The generated file and owned Workspace were cleaned. |
| Manual short-context compaction | Returned `no_op` without a model call or spurious usage. |
| Actual compaction | The maintained small-window native fixture performed a real compaction and a subsequent generation. Both produced confirmed receipts, respectively `context_maintenance` and `agent`; the project marker and selected tier survived. This is component acceptance, not a 1M-context benchmark. |
| DeepSeek Flash | Ordinary and high-thinking requests produced confirmed normalized usage, including a 5,888-token cache-read observation. The served model name was `deepseek-flash`, distinct from the requested alias. Search was not tested. |
| Native recovery | All five maintained cases passed: consume, Stop, Worker SIGKILL recovery, partial-stream Stop, and Worker + Control Plane SIGKILL. Native partial text, queue identity and the absence of PG streaming bodies remained correct. |
| Chat deletion | Removing the owned chat retained its consumption until the separately restricted acceptance-account purger ran. Fork independence is covered by storage separation/contracts; this slice did not repeat the large-history Fork benchmark. |

All owned live fixtures report both acceptance and cleanup success. Twenty-six
never-deployed candidate image tags were removed after checking serving references. Final checks
found 26 serving Pods Ready, no active Runs/writers, and the original two development
machine allocations, two Workspaces, 32 users, 35 model configurations, both OAuth
file hashes and Cube Pod identities unchanged.

## Failures found and corrected

1. Candidate preparation caught a missing Docker RUN continuation; no serving
   component was changed by that failed preparation.
2. APT's new advisory blocked the full-candidate scan. New Debian host images now
   install APT/libapt 2.6.2. The slim base lacks a system CA bundle, so the patch
   bootstraps through signed Debian archives with the affected retry path disabled;
   signature/certificate verification is not disabled. Retained Ubuntu Cube/Guest
   images still need separate maintenance, recorded below.
3. The first live receipt survived outage/restart but was incorrectly marked
   unpriced: optional zero-valued media fields were treated as actual extra
   consumption. The provider now checks positive quantities. Ordinary requested
   function-call counters do not imply hosted execution; provider-reported executed
   counters and unknown positive hosted dimensions remain unpriced. Regression
   tests and the repeated real fixture pass.
4. A later fixture assumed Control Plane shutdown would take longer than a future
   price's two-second activation delay. It now waits for that declared time rather
   than relying on shutdown latency; that failure occurred before any model call.

One native recovery probe raced the intentionally killed Control Plane container
and printed `container not found`; the restarted owner and all recovery assertions
subsequently passed. Temporary-account preservation probes are not the final
comparison; the strict final comparison was taken after cleanup.

## Remaining boundaries

- Statements are informational. Sandbox/storage billing, payment mode, balances,
  BYOK charging, allocation of platform-caused retry costs and real tariffs remain
  separate decisions. `includeFailed` is the explicit provider-failure quote rule;
  it does not implement all future commercial responsibility policies.
- Unknown usage is not silently zero. Source storage loss or usage never reported
  by the provider cannot be reconstructed by this adapter. The local receipt file
  is a single-host buffer, not a second balance database or a backup solution.
- Image/search/media tariffs not implemented here remain unpriced. Upstream cost
  estimates are not subscription invoices.
- The previously deferred approximately 131 MiB cold-network request was not rerun.
- Existing Cube/Guest APT maintenance for
  [CVE-2026-109518](https://ubuntu.com/security/CVE-2026-109518) remains in the
  [backlog](../BACKLOG.md). Billing publication did not rebuild those environments
  or claim that their existing base packages were patched.

Private evidence: `deploy/production/runtime/work-evidence/model-accounting-20261106/`
and the matching release directories. Source configuration, credentials, transcripts
and generated/user images are excluded from committed evidence.
