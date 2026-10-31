# Pi runtime adapter comparison

Source review on 2026-10-31. This is a code/document comparison, not deployment,
performance or failure-recovery acceptance of either external project.

## Sources and fit

- Rivet Agents at `e963879702cf40ccf5be71e8be970626413dd28a`,
  [Pi runtime](https://github.com/rivet-dev/agents/blob/e963879702cf40ccf5be71e8be970626413dd28a/packages/pi/src/runtime.ts),
  [sandbox ports](https://github.com/rivet-dev/agents/blob/e963879702cf40ccf5be71e8be970626413dd28a/packages/sandbox-adapter/src/index.ts),
  [native environment adapter](https://github.com/rivet-dev/agents/blob/e963879702cf40ccf5be71e8be970626413dd28a/packages/sandbox-adapter/src/pi/sandbox-env.ts),
  [Storage conformance](https://github.com/rivet-dev/agents/blob/e963879702cf40ccf5be71e8be970626413dd28a/packages/pi/tests/storage.test.ts).
  The Pi package is Apache-2.0, version 0.5.4, and targets Pi 1.4.
  Pi runs in an Actor; configured file/shell operations reach a separate sandbox.
- Pi on Cloudflare at `e75d46cd04bbbdcff165892bc84e00f0b66c0d6b`,
  [architecture](https://github.com/harshil1712/pi-on-cf/blob/e75d46cd04bbbdcff165892bc84e00f0b66c0d6b/docs/architecture.md),
  [session](https://github.com/harshil1712/pi-on-cf/blob/e75d46cd04bbbdcff165892bc84e00f0b66c0d6b/src/server/pi-session.ts),
  [project sections](https://github.com/harshil1712/pi-on-cf/blob/e75d46cd04bbbdcff165892bc84e00f0b66c0d6b/src/server/task.ts),
  [skills](https://github.com/harshil1712/pi-on-cf/blob/e75d46cd04bbbdcff165892bc84e00f0b66c0d6b/src/server/skills.ts).
  The app is MIT-licensed and targets Pi 1.4. Pi runs in a Durable Object;
  Computer supplies Worker and Linux-container execution backends.

Both keep Pi's native runtime outside the Linux tool environment. Their thinner
application adapters rely on platform-owned instance coordination, persistence
and wake-up. That does not establish that adding the same platform beside
PiCloud's existing PG/Kafka authorities would simplify its operational model.

## Lessons selected

1. Give lifecycle, execution preparation, files, images, terminal, preview,
   workflow and credentials focused ports. Preserve one resource owner and the
   existing whole-Tool boundary. Do not add a process, RPC, provider fallback or
   new durable state merely to separate TypeScript dependencies.
2. Make the architecture document explain the current message flow and authority
   first. Keep dated acceptance in a separate evidence index and decisions in ADRs.
3. Retain Pi's public Storage conformance and fake-model contracts. PiCloud already
   has both, in addition to infrastructure and live recovery tests.

The internal refactor preserves every provider method's existing signature and
optional capability behavior. The full provider type remains the composition
contract; callers use narrowed references. Workspace file routing is extracted
with callbacks to the original owner's machine/upload authorization. Those callbacks
do not create a second ownership cache or transfer lifecycle policy to file code.
There is no architectural invariant, durable authority or wire-protocol change.

## Deliberately not adopted

- Rivet's current binary reader first transfers the whole file into memory. Keep
  PiCloud's source-side bounded reads, truncation and image normalization.
- Cloudflare's virtual workspace/container synchronization is a different byte
  authority. Keep the persistent Cube Volume as PiCloud's sole Workspace authority.
- Do not mark whole-file writes or deletes replay-safe solely because of the tool
  name. Shared files can change between attempts; existing uncertainty remains.
- Do not replace PG/Kafka with, or add, an Actor framework in this slice.
  Replacing scheduling/storage authority requires a separately measured decision.
- Project AGENTS.md/Skill text discovery is a separate product slice. Reading
  instructions does not imply loading project extensions into the trusted Worker.
- Pi 1.4 API/upgrade evaluation and additional provider phase tracing are separate
  work. PiCloud stays pinned to 1.0, with its existing model/ownership contracts.

## Acceptance

The file consumer must compile and work with only a file capability, reject before
reading an upload body when admission fails, preserve current machine routing and
provider receiver binding, forward cancellation/stream identity, and never retry
an uncertain upload against another backend. Existing controller, lifecycle,
shared-VM, Cube, upload and recovery checks remain applicable.

See [delivery status](../reports/sandbox-capabilities-20261031.md).
