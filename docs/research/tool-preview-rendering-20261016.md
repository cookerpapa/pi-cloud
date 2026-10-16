# Tool preview rendering: adopt-before-build note

Date: 2026-10-16. Proposal support for [ADR-0252](../adr/0252-tool-receipt-and-ephemeral-preview.md).
No runtime dependency or production configuration was changed by this study.

## Measured requirement

The guest return-path review reproduces 102,913-byte progress frames for 51,200
visible bytes, dropped by the native 64 KiB forwarding gate. Follow-up source
inspection and a local `NativeToolOutput` probe show that `10%\r20%\r30%` becomes
`10%20%30%`: carriage returns are deleted, and the browser renders ordinary text.
Transport deltas alone cannot implement terminal overwrite semantics.

We need bounded, read-only recent-output previews with source-side interpretation
of carriage returns and common ANSI movement/erase sequences. The final Tool
collector, native execution, pipe attachment and process cancellation are separate.

## Candidates and choice

| Candidate | Evidence and role | Decision |
| --- | --- | --- |
| `@xterm/headless@6.0.0` | The official xterm.js Node build maintains terminal state; MIT; the project already pins browser `@xterm/xterm@6.0.0`. Public terminal writes/buffer reads cover split controls and cursor state. | Proposed interpreter behind a PiCloud preview adapter. Pin the version and npm integrity. Export bounded redacted plain text. |
| `strip-ansi` / Node's VT stripping | Maintained utilities remove control sequences from strings. They do not reconstruct prior cursor/screen state. | Useful for text cleaning, insufficient for replacing a previous progress line or multi-line redraw. Do not build a second terminal on top. |
| Microsoft `node-pty` | Maintained native module supplies pseudoterminal process I/O, not a rendered output model. | Changing Bash attachment would affect command behavior and process semantics; it does not solve lossy preview reconstruction by itself. Keep the existing executor. |
| Existing HTTP/SSE plus a bounded preview edit | Already implements tenant routing and browser streaming. | Retain transport. Add only a revision-bound display edit/reset; no telemetry broker, workflow history, log archive or reliable replay protocol. |

Primary sources: [xterm.js Node support](https://github.com/xtermjs/xterm.js#nodejs-support),
[release history](https://github.com/xtermjs/xterm.js/releases),
[6.0.0 license](https://github.com/xtermjs/xterm.js/blob/6.0.0/LICENSE),
[flow-control contract](https://xtermjs.org/docs/guides/flowcontrol/),
[strip-ansi source](https://github.com/chalk/strip-ansi),
[node-pty source](https://github.com/microsoft/node-pty).

## Isolated package evidence

Downloaded the published `@xterm/headless@6.0.0` tarball to an owned temporary
directory with lifecycle scripts disabled. No workspace dependency was installed.
The [captured results](../reports/tool-preview-library-probe-20261016.json) record
the package integrity, Node/esbuild versions and five parsing cases:

- carriage return retains `progress 30%`;
- clear-line followed by a shorter label retains `done`;
- an ANSI command split across writes still clears the line;
- cursor-up redraw changes the previous line while retaining the next one;
- Chinese/emoji plus clear-line produces the expected replacement text.

Each buffer read follows the library's `write` callback. The same package also
bundles and runs with the guest's Node 24 / ESM / esbuild 0.28.1 settings. This
establishes basic fit and bundling, not integrated preview correctness, live VM
acceptance, per-Tool resource cost or flood resilience.

The published package has an incorrect `module: lib/xterm.mjs` entry and no
exports map, also reported in the
[upstream issue](https://github.com/xtermjs/xterm.js/issues/6052). Its public CommonJS
`main` resolves correctly with Node and the tested Node-targeted esbuild settings.
Use the public package entry, not private internal module imports or a vendor patch.
Recheck resolution in upgrade/build contracts. Headless buffer access needs
`allowProposedApi:true` in this version, so pinning and behavior tests are required.

## Failure and exit strategy

The library buffers writes asynchronously; its own emergency watermark is much
larger than this preview needs. Feed bounded chunks, wait for parse callbacks and
bound application-owned pending bytes. Since a disposable preview must not apply
backpressure to command execution, overflow/failure retires that preview while the
independent final collector continues. Do not silently drop raw control bytes and
claim a complete terminal view.

Only plain text and a PiCloud revision/edit/reset schema leave the guest. No vendor
object enters Kafka, PG, model context or public durable schemas. Removing or
replacing the interpreter therefore affects only preview generation and requires
the same display/failure contracts, with no history or Workspace migration.
Matched rollback retains normal draining and native ownership requirements.

Adoption is conditional on source load/packaging and real guest acceptance in
ADR-0252; the five isolated parser cases do not waive those gates. A failed fit
must be reported before choosing another renderer, not hidden by a custom fallback.
