# ADR-0270: Guest browser capability and visible Tool-result actions

Status: implemented and deployed as `guest-browser-bd03f7a6`, schema 197.
Date: 2026-10-22.

Presentation amendment, 2026-10-24 (owner approved): remove the separate
application-action card and collapsed-group preview link. Preview keeps returning
the verified authenticated path to Pi; the Agent provides a named Markdown link
in its answer. The Web treats Preview as an ordinary Tool with expandable
parameters/result, without parsing answers to detect missing links or adding a
fallback action. Internal ports remain Tool arguments/diagnostics; ordinary
answer links use the application name. This supersedes the always-visible-action
decision and acceptance below. Native result metadata, storage, service probing,
proxy routing and guest browser capability are unchanged.

Owner amendment: the owner explicitly authorized deleting the current development
machine and its entire Workspace before this release. This supersedes the initial
Workspace preservation requirement below; retain conversations, accounts, provider
and model configuration, and credentials. A later proxy-port change is handled
under [ADR-0271](0271-local-upstream-proxy-configuration.md) before continuing delivery.

## Decision

The owner approved a preinstalled browser for ordinary frontend work after a
live application had no guest browser and its successfully published preview
was missing from the conversation. Keep browser execution in the existing Cube
Tool Sandbox and retain Pi's public Tools/Storage boundaries.

- Install pinned Playwright 1.64.1, its matching Chromium, required system
  libraries and CJK fonts in the standard guest image. A separate locked package
  under `/opt/pi-cloud/browser` keeps platform tooling independent of project
  dependencies. Browser binaries are baked into the image; launch browsers only
  for requested work and close them in `finally`. No resident browser service,
  desktop stream, scheduler, Worker browser or additional broker is introduced.
- Tell the Agent the stable module location and the existing Bash → Playwright
  → screenshot file → native Read path. Files and browser processes stay in Cube;
  the current image claim-check transport handles screenshot results. Pi core,
  model tools and execution authority remain unchanged.
- Extend the trusted native Tool display description with an optional reference
  to the same committed result's `details`. Resolve a PiCloud-owned structured
  `{content, details}` display output rather than throwing metadata away. Text
  remains bounded and image pixels are not copied into display events. Bound
  metadata too; oversized display metadata is omitted with an explicit notice.
  Descriptions contain selectors, never another persisted result body. Canonical
  history remains the native Tool result, already read in structured form.
- Preview parameters and results use expandable Tool details. Application
  navigation uses the Agent's answer link; no separate action is synthesized
  from Tool metadata. Native child progress remains independent and visible
  outside collapsed invocation groups.
- The Preview Tool returns its real authenticated platform path both as text
  and structured metadata. Its reply confirms publication, not that a particular
  browser already rendered a button. The Agent can include that path in its final
  answer; no guessed public URL or new preview state store is required.

The display-description change and guest image require matched Worker/Projector/
Web delivery. Under the owner amendment above, release the existing machine and
delete its Workspace through the normal lifecycle, confirming physical cleanup
before cutover. Preserve conversations, account/provider settings and credentials.
Destructive development authorization does not bypass writer/Volume fencing.

## Adopt-before-build evidence

[Playwright browser installation](https://playwright.dev/docs/browsers) couples
the library version to browser revisions and provides installation of system
dependencies. Its [Docker guidance](https://playwright.dev/docs/docker) supplies
the existing image-installation pattern. Pin the published
[1.64.1 release](https://github.com/microsoft/playwright/releases/tag/v1.64.1)
and npm lockfile, reusing its browser launcher/cleanup instead of implementing
a browser runtime. Keep Cube's existing base/guest contract and install the
required browser in that image; adopting an additional remote browser service
would add transport, routing and ownership without a demonstrated requirement.

## Acceptance

The October 22 artifact gate also requires rebuilding existing Go binaries with
the pinned [Go 1.26.10 patch release](https://go.dev/doc/devel/release#go1.26.10)
and updating Cube's image-installed
[certifi to 2026.10.19](https://pypi.org/project/certifi/2026.10.19/).
These dependency updates retain Cube's runtime and guest protocols. Browser/OS
image layers are kept independent of the source-pinned envd binary, and APT build
caches do not enter the guest image.

- The guest's actual unprivileged Tool user can launch Chromium, operate a local
  page, capture Chinese text/screenshots and close the browser. Test a failed
  interaction and cancellation/process cleanup; no image-build success alone
  establishes KVM/Tool usability.
- A real Luna Run uses the preinstalled stack and reads a screenshot through
  the existing attachment path. Native queue/Stop/recovery contracts remain.
- Live Tool display retains bounded structured metadata without duplicating
  committed bodies or image pixels. Missing/invalid references fail explicitly;
  no preview-name special case reconstructs metadata that transport discarded.
- Published preview paths match text/metadata. The Agent's named answer link
  renders during live streaming and after refresh, including when Tool steps
  are collapsed. Expanding Tool details exposes the arguments and result without
  creating another application-action card. Omitted answer links do not trigger
  a fallback or an additional model request.
- Complete appropriate source/artifact/live gates and scoped fixture cleanup.
  Existing conversations and account/configuration hashes are preserved; old
  application files are deleted under the explicit owner amendment.

[Delivery evidence](../reports/guest-browser-delivery-20261022.md) records the
matched release, source/artifact checks and real Luna guest browser, screenshot
and live/cold preview results, including retained failed attempts.
