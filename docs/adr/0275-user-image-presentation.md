# ADR-0275: User-facing image presentation

Status: implemented and deployed as `show-image-1f7a950e`.
Date: 2026-10-25.

## Decision

Add the execution-owned ordinary `show_image` Tool with required `path` and optional
`caption`. It reads and normalizes an existing image through ADR-0274's bound Cube
image I/O, then returns ordinary native image content. It never calls an image
provider, modifies the source, creates another queue or loads a Skill. It is
available whenever Session attachment storage is configured, independently of
image-generation configuration. Native unsafe settlement and the existing
non-replayable control-effect admission preserve a single display attempt across
uncertain ownership/reply failures; a later explicit call is a new snapshot.

The browser presents successful `show_image` and `generate_image` results inline,
outside collapsed Tool activity. The Tool details retain parameters, paths and
diagnostics. Images keep their place after the producing Tool; later Tools cannot
absorb them into a collapsed group. Expanding details does not render a second
copy. Captions are plain text and clicking the image opens the authenticated asset.
Ordinary Read continues serving model vision and does not automatically publish
every internal screenshot to the user. The renderers share the same component.

## Canonical presentation boundary

Human image addresses are derived from canonical native image parts after Worker
Harness processing, not from executor-supplied `generatedImage.previewPath`.
Extend the existing Tool completion image descriptor with an optional same-commit
write selector. Image hints without a selector remain metadata-only; no bytes are
copied into the descriptor. The Projector resolves selected packed image references
into a PiCloud-owned public content part (`type: image`, `imageId`, `previewPath`,
`mimeType`). Cold native-history reads use the same conversion and the requested
public Session identity, including forks/child views. The source remains the
existing immutable S3 attachment and the existing retained-image HTTP endpoint.

The Web image renderer uses canonical public content. Generation-specific metadata
remains technical outcome data; its old display-specific reader is removed.
Existing native history is not rewritten or erased to obtain the new display.
Generation and explicit display instructions describe the application presentation
contract and avoid asking the model to embed another copy. No Markdown scanning,
answer deduplication or inferred fallback card is introduced.

## Reuse and acceptance

Reuse Pi's public remote Tool contract, the existing catalog, bound guest image
I/O, S3 codec, same-commit display selectors, retained-image endpoint and React
image component. No new infrastructure, storage authority or vendor SDK is needed.

Verify Tool registration without image-provider configuration; path/caption
validation; missing/invalid files; cancellation and late results; canonical live
and cold addresses; plain-text captions; single/grouped Tool presentation; no
early image before a successful canonical result; and immutable display after
source replacement. Use a real Luna/Cube screenshot and a real browser, keeping
Tool details collapsed and reloading the conversation. Publish matched artifacts
and preserve existing user conversations, images, Workspaces and applications.

[Delivery evidence](../reports/show-image-delivery-20261025.md) records the matched
publication and successful real screenshot, source-removal and browser checks.
