# User-facing image presentation delivery — 2026-10-25

Source `1f7a950edb056d9c4997f5797d4b88b844f03e1b` implements
[ADR-0275](../adr/0275-user-image-presentation.md), deployed as
`show-image-1f7a950e` (application Helm revision 98). Schema 198, managed Cube
protocol 8, guest protocol 7 and Pi 1.0.0 remain unchanged.

## Behavior and data flow

`show_image({path, caption?})` reads an existing image through the bound Cube
guest image-I/O path. It needs Session attachment storage, but no image-provider
configuration. The normal boot-scoped reply reaches Pi's Worker Harness; only its
canonical Tool Result authorizes public display. Kafka and PostgreSQL keep image
references, with immutable bytes in the existing object store.

Projector live events and cold-history reads derive public image addresses from
canonical attachment parts. Both `show_image` and `generate_image` render inline
outside collapsed activity, with plain captions and a clickable image. Technical
arguments remain in details; opening them does not render another image. Ordinary
Read remains model-facing. Executor-specific generation preview metadata no
longer controls the frontend. There is no Markdown-link scan or new storage queue.

Missing/unreadable files return a normal Tool error. Cancellation and ownership
loss prevent a late image from becoming a successful presentation. Existing
non-replayable control-effect admission and native unsafe settlement apply; an
uncertain attempt is not automatically repeated. Explicit subsequent calls take
new snapshots. Successful retained images survive source replacement/deletion.

## Verification

- Relevant Tool, catalog/dispatch, canonical image selector, cold-history and Web
  tests passed, including real PostgreSQL conversation/dispatch coverage,
  cancellation, invalid input, plain captions and chronological grouping.
- All workspace type checks, formatting, documentation, runtime policy, Helm,
  image input/closure checks and the Web production build passed.
- Real-browser presentation checks cover running/completed Turns, collapsed
  activity, image navigation and details without a duplicate image.
- Source dependency audit and the twelve-artifact matched release gate passed.
- The maintained `browser` acceptance scope used GPT-6 Luna and actual Cube
  Chromium. It clicked the test application, captured a screenshot, inspected it
  through Read and displayed it through `show_image`. The live screenshot shows
  the image while the Agent is still working. The source file was then deleted;
  authenticated image bytes still matched the retained reference, and a browser
  reload displayed the same image with activity collapsed. The final named app
  link and actual application navigation also passed.
- No image-generation service request was needed. A read-only check of the
  existing galgame conversation reconstructed its prior generated image from
  canonical history and verified the retained bytes.

Reproduce the live check with the command documented in
[matched releases](../MATCHED_RELEASE.md). Private evidence is under
`deploy/production/runtime/release-evidence/show-image-20261025/`; screenshots and
private resource identifiers are not committed.

## Preservation and cleanup

Writers were quiescent before exact old-allocation closure and recorded-node
absence confirmation. The logical development machine and its Workspace were
retained; the new controller restored running intent. Both original application
servers were restarted and served matching HTTP body hashes.

All fifteen protected PostgreSQL data sets, credentials/configuration and existing
Workspace content matched before and after publication. Of 52 Workspace files,
only the expected application PID and runtime log changed. The owned acceptance
Session, VM, Volume, two image objects and tenant were physically cleaned up;
the maintained acceptance report records `accepted: true` and
`cleanupConfirmed: true`.
