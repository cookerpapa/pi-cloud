# ADR-0191: GPT-6 model catalog and current DeepSeek search evidence

Status: implemented and locally validated (2026-09-26).
See [acceptance](../reports/image-attachments-20260926.md).
The later owner-requested [Flash catalog amendment](../reports/flash-catalog-20260926.md)
is also deployed and locally validated.

## Decision

### GPT-6.1 Sol amendment (2026-10-21)

The owner requests the GPT-6.1 family. The official catalog currently provides
`gpt-6.1-sol`; Astra and Luna retain their GPT-6 identities. Replace the maintained
Sol choice and new-conversation default with GPT-6.1 Sol, with medium reasoning
by default and low/medium/high/xhigh/max available. Disabled/minimal reasoning
is unsupported. Keep Luna for routine paid acceptance and Astra as an explicit
choice. Keep the reviewed Responses transport, vision, web search and Fast
capabilities, subject to live acceptance. Do not add Ultrafast or new hosted Tools.
Retain the existing conservative context/output budgets.

Pin the gateway's embedded upstream catalog to
`690c37fdbe62dc05f609f3a3e609d07ea4d16bf1`, which introduces GPT-6.1 Sol;
the CLIProxyAPI executable source and Pi dependencies remain pinned as before.
The upstream gateway may refresh its own metadata, but PiCloud's reviewed catalog
still governs its public choices and issued capabilities. There is no model alias
or silent fallback to another model.

Migration 195 updates only future Sol profiles, brokered route references and
desired Session settings while writers are drained. Preserve supported reasoning
choices and map off/minimal to medium, including restricted profile allowlists.
Issued Run snapshots and native history keep the model actually used; accounts,
credential material, other models and Fast settings remain unchanged. New
deployments and upgraded deployments use the same model contract.

At <=272K input, Standard API input/output remain $2/$10 per million tokens;
cached input falls from $0.20 to $0.10. Codex Standard credit rates similarly
retain 50/250 input/output and reduce cached input from 5 to 2.5 credits per
million. This is a cache-price reduction versus GPT-6 Sol, not a blanket 50%
discount or a promise about subscription-plan usage. PiCloud stores token usage,
not a competing billing price table.

Acceptance: current catalog/selection validation, native Responses payload
contracts, real-PG migration preserving immutable history, routine Luna
regression, and real GPT-6.1 Sol text/function/vision/search on the deployed route.
Reject unsupported reasoning before model admission. Use the maintained matched
release; no backward schema/model decoder is retained. If upstream availability
fails, keep the failure visible and repair the route or roll forward while drained.

Sources: [official model](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[current models](https://developers.openai.com/api/docs/models),
[API prices](https://developers.openai.com/api/docs/pricing),
[Codex credit rates](https://learn.chatgpt.com/docs/pricing#token-rates), and
[gateway catalog](https://github.com/router-for-me/models/blob/690c37fdbe62dc05f609f3a3e609d07ea4d16bf1/models.json).

Release checks also require the existing Caddy/CLIProxyAPI/Cube Go dependency
overrides to pin `github.com/klauspost/compress` v1.18.7. The
[upstream release](https://github.com/klauspost/compress/releases/tag/v1.18.7)
contains a security correction without other changes. Cube patch 0013 updates
only module versions/checksums; execution and management protocols stay at 7.
The disposable SeaweedFS test fixture retains its native eight-volume capacity:
four slots were insufficient for its initial seven-volume growth batch. This
changes neither production storage limits nor the asset recovery protocol.

### Original GPT-6 migration (2026-09-26)

The owner requested migration to GPT-6 and GPT-6 Luna for paid acceptance tests.
Use GPT-6 Sol as the new-conversation default and GPT-6 Luna for routine probes.
Offer Astra as an explicitly selected higher-cost model; never substitute it for
Sol/Luna. Keep Responses transport, Pi's public provider adapter, existing
reasoning settings where supported and request-scoped Fast mode. Astra excludes
disabled reasoning. Do not adopt new asynchronous Tool/steering APIs in this slice.

Replace the maintained GPT-5.6 selection catalog. Migrate mutable model profiles
and desired Session selections (5.6 Sol/Terra to 6 Sol, 5.6 Luna to 6 Luna), leaving
issued Turn/Run snapshots and native history as evidence of the actual model used.
The cutover requires quiescence. No compatibility alias silently routes old model
names to different models.

CLIProxyAPI's pinned code supports the newer upstream model catalog, but its
embedded snapshot lacks GPT-6. Pin and embed the upstream catalog revision
`4d4647e8ca669f23c27c76a7d0bc32fe98d0a909` when building the existing gateway.
This is deployment metadata, not a second model proxy or provider implementation.

Owner amendment, 2026-09-26: show DeepSeek V4.1 Flash and hide V4 Pro from the
conversation/admin selection catalog. Keep Flash's `web_search` declaration on
the existing Responses route at the owner's explicit request, even while the
upstream ignores it. This is a requested Tool declaration, not evidence of an
executed search; only actual provider events/results appear as search activity.
Do not substitute a search backend or switch provider protocols. Retain existing
model identities and issued history; this change does not remap Pro to Flash.
The local rollout must verify no desired Session or default still selects Pro.

On 2026-09-26, the official `/models` endpoint returned
only `deepseek-flash` and `deepseek-v4-pro`; a direct Flash Responses request with
`web_search` and required tool choice returned a message and zero search calls.
The current Responses documentation explicitly marks built-in search as ignored.
There is no verified public separate search-model ID. A second direct request
using the same `deepseek-flash` model on `/anthropic/v1/messages` returned two
`web_search_tool_result` blocks. Thus hosted search works on the Anthropic route,
while the currently integrated Responses route still ignores it. This is not a
distinct official search model. Third-party web proxies publish `-search` aliases;
the official endpoint rejects those names. Switching Flash's provider protocol/transcript
adapter is a separate vertical slice; this migration does not silently add an
auxiliary search-model request or change its wire protocol.

## Evidence and tradeoffs

- [GPT-6 migration](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#migration-quickstart)
  preserves Responses function calling; Astra cannot use `none` reasoning.
- [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) and
  [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) support text/images
  and web search. Retain existing conservative runtime context/output limits in
  this migration instead of conflating API ceilings with subscription-route limits.
- [Standard API pricing](https://developers.openai.com/api/docs/pricing): per 1M
  tokens at <=272K input, Sol input/output is $2/$10 versus 5.6 Sol $4/$20;
  Luna is $0.10/$0.50 versus 5.6 Luna $0.20/$1.20. Subscription gateway billing is
  not equivalent to these API prices. Astra is not the lower-cost replacement.
- [DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/) and
  [model discovery](https://api-docs.deepseek.com/api/list-models/).
- [Gateway model catalog source](https://github.com/router-for-me/models/blob/4d4647e8ca669f23c27c76a7d0bc32fe98d0a909/models.json).

Acceptance: catalog/schema tests; mutable-selection migration with immutable
history; genuine GPT-6 Luna completion, function Tool round trip, image input and
hosted search through the deployed gateway. Failed availability never falls back
to a different model. Rollback uses the prior image/catalog and pre-migration
database backup; do not rewrite historical model output.

The Flash visibility amendment additionally requires public/admin catalog checks,
Worker runtime/Tool declaration checks and a real Flash completion/vision call
through the deployed gateway with `web_search` present. An ignored search must
not be reported as a successful search. No schema or database migration is needed.
