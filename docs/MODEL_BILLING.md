# Model metering and statements

[ADR-0297](adr/0297-model-metering-receipts-and-statements.md) adds an accounting
port beside native execution. The account menu's **Model costs** page shows model
usage and simulated amounts. It excludes Sandbox/storage costs and never collects
payment. `/usage` still describes native conversation usage and context estimates.

## Flow and authority

Worker Model Gateway and the image Tool caller attach a new invocation UUID and
bounded tenant/Session/Conversation/Run/purpose metadata to each HTTP request.
This attribution is independent of the reusable model transport key. The provider
removes the private header before forwarding model work. Its v8 execution UUIDs
distinguish fallback/retry attempts within one invocation.

Before dispatch, the provider commits admission to `/data/model-metering.bolt` on
its existing volume. The pinned bbolt adapter captures attempt starts and normalized
usage synchronously, before CPA's asynchronous plugin queue. Only identities,
timing, model/tier, quality and quantities are retained; never model payloads,
credentials, upstream URLs, error bodies or image bytes.

The provider sends batches of at most 128 receipts to
`POST /internal/v1/model-metering`, authenticated with the existing provider-service
key. Acknowledgement follows the PG transaction. Lost acknowledgements resend the
same identities; duplicate contents do not add consumption. A changed identity
or payload conflicts and leaves the source receipts pending for investigation.
Neither receiver downtime nor accounting recovery retries a model or Tool.

PG owns `model_invocations`, immutable `model_metering_events`, and
`model_rate_versions`. These have no cascading relationship to chat/native history.
Deleting a chat, Compaction and Fork do not erase or copy actual consumption.
The only cleanup exception is the explicitly owned acceptance-fixture purger.

## Missing observations and limits

- A live invocation is pending. A started attempt without usage, interrupted
  admission, empty synthesized usage or incomplete token classification remains
  unconfirmed. It is not silently free or charged from an estimate.
- Known receipts remain useful even when another attempt is unconfirmed; a partial
  statement must not be mistaken for a complete provider invoice.
- Receiver downtime uses the local buffer. The default 64 MiB admission watermark
  reserves space for in-flight completions; admitted receipts are not dropped to
  regain capacity. New model work receives a pre-dispatch 503 when it cannot be
  recorded. ACK cleanup restores capacity. In-flight completion writes may exceed
  the admission watermark.
- Provider restart marks unfinished admissions interrupted and sends their existing
  receipts. A disk loss can destroy that single-host buffer. No implementation can
  reconstruct usage the provider never reported or a response lost before capture.
- An I/O failure after dispatch is logged without changing the model's result or
  causing replay. Already saved starts identify missing receipts. Restoring local
  writes permits new admission; it does not manufacture the missing usage.
- Delivery and metering failures log identifiers and bounded classifications only.
  The local journal is financial metadata, not a substitute for PG backup or an
  independent balance database.

## Prices

The platform operator creates immutable rate versions for an account, model and
service tier. Rates have a future effective time, currency, explicit failed-attempt
policy and decimal prices **per million tokens**. `customer` is a simulated customer
quote; `upstream_estimate` is a separate optional estimate. Neither is copied from
the other or inferred from a subscription. No real rates are seeded automatically.

Input, cache read, cache write, non-reasoning output and reasoning are disjoint
buckets from CPA v8's canonical accounting. Prices accept up to six decimal places
per million tokens; amounts are stored as exact integer trillionths of the currency
(`amountPico`). Summation uses integer/numeric arithmetic, with no per-token cent
rounding. A receipt permanently retains the rate selected at its actual attempt
start time. Later rate changes and duplicate receipt delivery do not rewrite it.

Image generation, hosted search and other unsupported media dimensions remain
unpriced even when token counts are available. Ordinary vision tokens can be
counted when the provider supplies canonical quantities. Incomplete quantities
remain unconfirmed. `includeFailed: false` explicitly waives reported failed
attempts; it does not suppress their usage facts.

## API

All public routes use existing tenant authentication. Only the platform owner can
select another `tenantId` or create rates. Reads do not require the original chat
or Run to exist.

- `GET /v1/model-billing`: filters `from` (inclusive), `to` (exclusive), optional
  `sessionId`/`model`. Pages contain up to 200 invocations (default 50); the returned
  `next.time`/`next.id` become `beforeTime`/`beforeId`.
- `GET /v1/model-billing/summary`: the same filters, totals grouped by pricing
  kind/state/currency. Never sum different currencies into one number.
- `GET /v1/model-billing/export`: streams the selected range as NDJSON using bounded
  DB pages. The Web page also offers an explicit current-page export.
- `GET /v1/model-billing/rates`: the latest 500 configured versions for the account.
- `POST /v1/model-billing/rates?tenantId=...`: platform operator only. Body:

```json
{
  "kind": "customer",
  "provider": "openai-codex",
  "model": "example-model",
  "serviceTier": "default",
  "effectiveAt": "2099-01-01T00:00:00.000Z",
  "currency": "USD",
  "includeFailed": false,
  "perMillion": {
    "input": "1.25",
    "cacheRead": "0.125",
    "cacheWrite": "2.5",
    "output": "5",
    "reasoning": "5"
  }
}
```

This is a fixture, not a published model tariff. Match the model/tier actually
reported by the provider. Backdated new changes are rejected. An identical retry, including after its
effective time, returns the existing version; conflicting reuse is rejected. There is no edit/delete
route for a historical rate or receipt. Payments, wallets, BYOK collection and
Sandbox billing require separate business decisions before enabling collection.

## Publication

Schema 210 and Worker/provider/API/Web must publish together. The ADR-0297
`--retain-sandbox-runtime` option on the maintained matched operator proves that
existing Cube/Guest inputs are unchanged except additive host accounting exports.
It builds/scans the seven host images being published and retains the original
evidence for six unchanged Sandbox artifacts. It still drains Runs and Session
writers; it does not destroy VMs or change the
Guest template. Original Cube artifact provenance stays in `deployment.json`.
Changed execution interfaces, native patches or Guest inputs reject this path.

The provider needs `PI_CLOUD_METERING_PATH`, `PI_CLOUD_METERING_URL` and
`PI_CLOUD_METERING_KEY_FILE`; the API uses `PI_CLOUD_MODEL_METERING_TOKEN_FILE`.
Maintained Helm templates supply these from the existing provider credential.
Delivery bypasses the public egress proxy. A missing/failed source journal refuses
attributed model work before dispatch. Ordinary non-PiCloud CPA callers have no
cloud attribution and do not enter the tenant statement.

The owned acceptance drivers are:

```sh
node scripts/run-model-billing-browser-check.mjs
PI_CLOUD_LIVE_MODEL_METERING_CHECK=1 node --import tsx scripts/run-live-model-metering-check.mjs /private/metering.json
PI_CLOUD_LIVE_MODEL_CONTINUATION_CHECK=1 node --import tsx scripts/run-live-model-continuation-check.mjs /private/continuation
```

The first live driver requires no unrelated active Runs, temporarily stops the
Control Plane, performs one owned Luna request, replaces the provider while the
receiver is down, restores it, and verifies the receipt, explicit fixture tariff,
duplicate delivery, tenant API/export and browser. It restores services on errors.
The continuation driver verifies ordinary Worker/Cube requests from two owners
retain their own Run attribution. Fixture financial rows are purged only through
the restricted owned-fixture cleanup path.
