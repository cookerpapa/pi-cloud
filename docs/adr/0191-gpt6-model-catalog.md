# ADR-0191: GPT-6 model catalog and current DeepSeek search evidence

Status: implemented and locally validated (2026-09-26).
See [acceptance](../reports/image-attachments-20260926.md).

## Decision

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

DeepSeek Flash stays hidden. On 2026-09-26, the official `/models` endpoint returned
only `deepseek-flash` and `deepseek-v4-pro`; a direct Flash Responses request with
`web_search` and required tool choice returned a message and zero search calls.
The current Responses documentation explicitly marks built-in search as ignored.
There is no verified public separate search-model ID. A second direct request
using the same `deepseek-flash` model on `/anthropic/v1/messages` returned two
`web_search_tool_result` blocks. Thus hosted search works on the Anthropic route,
while the currently integrated Responses route still ignores it. This is not a
distinct public search model. Switching Flash's provider protocol/transcript
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
