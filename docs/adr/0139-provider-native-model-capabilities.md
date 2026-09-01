# ADR-0139: Provider-native model capabilities

## Status

Accepted on 2026-09-01.

## Context

Pi already normalizes ordinary messages, reasoning blocks and function Tool
calls sufficiently for a conversation to continue with another Provider. A
cloud deployment still has to freeze the effective model route for each Turn
and must not claim that a Provider feature is available merely because it
exists in that Provider's consumer product or public model description.

PiCloud's trusted Tools (`read`, `write`, `edit`, `bash`, `preview` and governed
Subagent Tools) are client-executed function Tools. Web search and image
generation may instead be executed by a model Provider. Reimplementing those
services inside PiCloud would add a second search/image authority and another
credential/network boundary without improving Workspace isolation.

The pinned Pi 0.84.1 Responses adapter exposes the public `onPayload` hook and
can therefore receive a deployment-owned hosted-Tool declaration without
patching the Agent Loop. It currently preserves the resulting assistant text,
but does not expose a portable image-generation result block. Image input is a
model modality rather than a Tool and still requires a product attachment
path.

Production probes through the pinned CLIProxyAPI route established the
effective capabilities, rather than assuming wire compatibility:

- the OpenAI Codex Responses route executes `web_search` and returns a final
  assistant message through Pi's existing stream parser;
- the original DeepSeek Chat Completions route supported Pi function Tools but
  could not carry a server-hosted Tool declaration;
- an OpenAI hosted image-generation call succeeds upstream, but Pi 0.84.1 does
  not yet expose its image result through the Agent message contract.

## Decision

- Provider-hosted capabilities are deployment-owned immutable runtime metadata.
  They are never selected by the browser or model.
- Every issued model-runtime capability carries its input modalities and hosted
  Tool set. A checked-out Pi runtime is keyed by that complete capability, so
  two Runs cannot accidentally reuse a differently configured runtime.
- The normal Agent request merges the supported hosted Tool declarations into
  the Provider-native payload through Pi's public `onPayload` hook. Pi function
  Tools remain unchanged and continue to execute through Tool Broker.
- Hosted Tools are enabled only after an end-to-end probe through the exact
  Provider Gateway route. Unsupported declarations are omitted rather than
  translated into PiCloud-owned replacement Tools.
- Model changes remain idle-Session operations and affect only the next Turn.
  Historical Turns retain their original Provider/model snapshot; the next
  runtime reconstructs its Tool and modality set from its own capability.
- The product UI does not display a synthetic model-switch or capability
  notice. Provider output remains unmodified.
- Hosted Tool start/completion boundaries may appear as ephemeral Run progress.
  They contain no query, result or Provider identifier and remain in the
  bounded Kafka live tail. Completed native actions and assistant citations are
  instead part of the issuing Pi message under ADR-0141; PiCloud maintains no
  parallel Provider-activity sidecar.
- For this revision, OpenAI Codex and the native DeepSeek Responses route expose
  hosted Web Search. Provider image
  generation and user image attachments remain disabled until Pi's portable
  result/input contracts can be persisted and restored end to end.

## Consequences

- PiCloud does not operate a trusted search or image-generation service.
- A model switch may change the callable hosted Tool set at the next Turn
  boundary. Completed assistant text and ordinary Pi Tool history remain in the
  native Session.
- Provider search is not a Tool Broker operation and consumes no Cube capacity.
- Adding another hosted capability requires a protocol adapter, persistence and
  recovery acceptance test; adding a name to a catalog is insufficient.
