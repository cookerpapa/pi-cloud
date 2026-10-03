# Unlimited product quotas — 2026-10-03

Status: deployed; elastic, machine and queued-image acceptance complete.
Decision: [ADR-0215](../adr/0215-unlimited-product-quotas.md).
Preceding migration: [K3s cutover](k3s-migration-20261003.md).

## Result

Product limits default to absent (`null` in policy/Helm, `unlimited` in environment
configuration), including tenant/project/Session counts, Worker families, model
concurrency, Subagent depth/descendant counts and per-Run model/Tool call counts.
The pending-input count cap and its admission count query were removed. Migrations
166–168 clear previous quota values and remove upload-size/attachment-count checks.

Self-hosted containers retain scheduling requests and omit CPU/memory limits;
PiCloud's Go memory override, scratch-volume size ceilings and custom per-Pod PID
ceiling are removed. VM specifications, real host memory, provider capabilities,
wire envelopes, ownership/leases/fencing, cancellation and transport backpressure
remain. Optional explicit finite quotas continue to be ordinary current policy.

Files stream from the browser through the existing HTTP/Workspace ports. The
browser hashes bounded slices; receivers verify length and SHA-256 before atomic
file publication. Upload claims renew and active image sources are pinned before
S3 transfer. Images stream to Workspace and S3 with backpressure. Dedicated
machines receive a private guest temporary file plus a small metadata envelope.
There is no control-plane file spool or second Workspace byte authority.

## Verification

- Complete native-PG workspace test run: 1,596 passed, eight opt-in tests skipped.
- After the binary-parser correction: nine focused assertions passed; two tests
  requiring a separate Kafka integration fixture were skipped. The actual Kafka
  path was subsequently exercised by the real-model acceptance below.
- Fault matrix: all 138 cases passed at clean source `6a698e13dd82`.
- Deployment helper contracts: 57 passed, including shared-mount drift,
  completion/native-version mismatch and source-identity invalidation.
- Type checks, application build, formatting, documentation links, Helm,
  installation, runtime-budget and image-closure checks passed. The high-severity
  dependency audit gate passed; its existing moderate findings remain reported.
- Tests cross the former project/Session, model-request, concurrency and upload
  limits; a generated 65 MiB file verifies streaming, truncation, overlong bodies
  and cancellation. Other cases cover corrupted/forged digests, duplicate receipts,
  symlinks, user-modified destinations, revoked claims, lease renewal and GC races.

Both elastic Workspace and dedicated-machine browser acceptance uploaded six
files per message, approximately 60.86 MB total, including a 24.16 MB PNG. GPT-6
Luna read the image without an Agent Tool. A later `read`/`bash` round completed,
then a different Worker recovered the original image and correctly answered a
previously unasked visual attribute. Changing the mutable Workspace image did
not change the retained Session image. Native reference records were 3,822 bytes.
The queued-image test also passed: edit retained the attachment, promotion delivered
visual input once within the active Run, and the source queued Run was cancelled.
Seven real Luna Runs completed across the three scenarios. Exact results are in the [machine-readable evidence](unlimited-quotas-20261003.json).

## Findings repaired during acceptance

1. An unlimited Linux cgroup can report `UINT64_MAX`; treating it as usable RAM
   blocked every new Worker claim. Memory admission now uses the smaller of the
   cgroup budget and physical RAM, while still checking available memory.
2. A global streaming octet parser also changed internal publication requests
   from Buffers to streams, rejecting writer admission. Streaming is now an
   explicit upload-route option; internal binary JSON keeps its bounded envelope.
   Integration fixtures use the actual parser instead of a copied implementation.
3. The resource-only Cube Helm upgrade restored the upstream shared-directory
   path and removed a Cubelet configuration mount. Upload placement still worked,
   but mounting that Volume into a VM failed. The installer-owned mounts were
   restored, and deployment now rejects inconsistent Workspace roots/configuration.
4. The same Helm upgrade restored an older Cubelet native patch set, which broke
   scoped Tool stopping. The maintained `9921cb020fa94551` native patches were
   restored, and the completion adapter was rebuilt from current sources.
   Deployment now checks both native version and completion source identity.
   Cube upgrades must use the complete installer/reconciliation workflow.

Failed live attempts are not counted as successful acceptance. These repairs
preserve one Session writer and the existing PG/Kafka/Cube authorities; no shell
operation was replayed to recover a failed Run. The Cube Node was changed only
after empty runtime inventory and no active Runs were confirmed.

## Deployment and limits

Schema: 168. Application image set: `k3s-6a698e13dd82-murvv8eo`.
Guest identity: `40422e3847ba4a21215cbbdf883d10f2fb3c2643`.
Cubelet native patch set: `9921cb020fa94551`; completion identity:
`bc8ff38b8604a288dcbfaf23b85c7d4584078ae9`.

Final inspection found zero active Runs/VMs, two ready Workers with no Session
quota, no bounded tenant/domain policies, no hard limits on the inspected PiCloud
containers and `podPidsLimit=-1`. Acceptance fixtures were cleaned.

This is a single-node acceptance, not a demonstration of arbitrary physical
capacity. Uploads retry the whole verified file; resumable byte offsets were not
introduced. Cube deferred cleanup of 31 older template-cache entries through RPC
timeouts; those caches are separate from the business data reset and retained
Workspace/Session assets. Template registration and current runtime execution
succeeded. Missing health evidence still never authorizes VM destruction.
