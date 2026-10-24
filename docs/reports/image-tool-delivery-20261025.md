# Explicit image Tool delivery — 2026-10-25

`image-tool-0bac4e97` is deployed (Helm revision 97, schema 198). Source commits
`5e885f2a` and `0bac4e97` implement ADR-0274. The final matched set contains twelve
scanned artifacts. Existing accounts, model settings, Workspace bytes and native
history are retained.

## Result and scope

The ordinary `generate_image` Tool exposes Codex-shaped `prompt`,
`referenced_image_paths`, `num_last_images_to_include` and
`transparent_background`. The selectors are mutually exclusive. The execution
registry sends its definition through the existing Worker management connection;
the Worker uses its generic Pi Tool callback. No Skill loader or Pi loop patch
was added.

Image requests use the configured CLIProxyAPI Images route. The current gateway
was verified with its existing subscription credentials; no new upstream API key
was configured. The pinned gateway's Images-only guard prevents account/model
failover after executor admission. Ordinary model requests retain their existing
policy. This is an explicit maintained source overlay, tested during its build.

Cube reads reference paths and normalizes image data, using the existing image
preparation queue. Generated PNGs are published exclusively under
`generated_images/`. Conversation reference selection uses the invoking native
assistant entry and active Conversation context, excluding later inputs and
unrelated Lanes. Native final results use S3 references through Kafka/PG. The
authenticated image route requires a retained Session reference.

## Verification

- Relevant native/catalog/dispatcher/image/Workspace/Web tests passed. An initial
  upload-wrapper regression was repaired by retaining its asynchronous rejection
  contract, then the affected tests passed again.
- All workspace type checks passed, including the corrected new test types.
  Documentation, formatting, Helm, runtime budgets, build inputs and source audit
  passed.
- The full fault evaluation passed 375 cases. The subsequent image-admission and
  cancellation change passed the controller's 54 tests. The added guest decoding
  refusal and reference-size tests passed separately.
- Real PostgreSQL/RF3 Kafka transport: 9 tests passed. Browser presentation checks
  include loading an actual retained-image response.
- Both matched candidates passed the twelve-artifact evidence gate. The earlier
  `image-tool-5e885f2a` candidate was not installed; the final one includes shared
  guest decode admission and cancellation.
- An isolated GPT-6 Luna conversation invoked the new Tool twice: first with a
  Workspace reference path, then with `num_last_images_to_include: 1` to edit its
  previously generated image. Both calls completed and returned saved paths,
  one reference and retained image content. The resulting PNGs are 2,801,667 and
  2,903,726 bytes, both 1024×1536, with non-opaque alpha channels. Visual inspection
  confirms that the second image retains the first character and adds the
  requested scarf.
- Both images loaded in the live browser. Reloading the conversation also loaded
  the retained image. Their HTTP bytes match the canonical attachment digests.
  Test Workspace deletion was physically confirmed before purging the owned
  tenant and its image objects.

## Existing-conversation attempt and corrective configuration

The owner's exact requested message was sent to the existing galgame conversation.
Its native system entry contains the new Tool definition. However, that attempt
did not invoke `generate_image`: the gateway's old configuration still injected
the hosted image tool, and the model reported image-service moderation refusal.
No image was produced. This attempt is **not** recorded as successful generation.
The original reference was not repeatedly tried through alternative interfaces.

This exposed a deployment omission: existing installations do not run the fresh
initializer. The matched operator now reconciles the same provider runtime policy
after writer drain and before cutover. For this installed release, the private
configuration was updated to `disable-image-generation: passthrough`, preserving
all other credential/routing fields, and only the provider was restarted while
no Run was active. The running Pod's setting was verified. The successful isolated
acceptance above ran after this correction. A successful generation using the
owner's original character reference remains unverified.

## Preservation and final state

The old allocation was closed and confirmed absent on its recorded node before
its live handle was cleared. The same logical machine and Workspace recovered as
generation 6. Both original applications were restored and their HTTP body hashes
match. Before the requested user-message test, all fifteen protected PG snapshots,
51 Workspace files (apart from expected PID/log changes), and 27 configuration/
credential-file comparisons passed. Provider YAML comparison permits only the
explicit runtime-policy change. The user's conversation was subsequently extended
by the requested test; it was not reset or replaced.

Final inspection: 28 Ready running Pods, one ready retained dedicated machine,
and zero active Runs, writers, Tool bindings, elastic test runtimes or terminals.
The temporary credential used for the existing-conversation check was removed.
User images, transcripts, credentials and repositories are not committed.

Private evidence: `deploy/production/runtime/release-evidence/image-tool-20261025/`.
Final image evidence: `deploy/production/runtime/releases/image-tool-0bac4e97/evidence/`.
