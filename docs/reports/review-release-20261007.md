# October 7 repair rollout

The owner-authorized deployment of
[the review repairs](review-repair-20261007.md) is complete. Application/provider
images use **review-release-8244934a**, built from
`8244934ad7d080db50c204d827c9ccf6ac4d3afd`. Schema **182** and its Session activity
index are installed. [Machine-readable evidence](review-release-20261007.json)
records exact image IDs, release revisions, cleanup and acceptance.

- Helm revisions: PiCloud **26**, infrastructure **25**, Cube **51**.
- Two ready Workers, ready Control Plane/Web/Volume Gateway, **32/32** publication partitions.
- Cube native images remain `template-cleanup-59f3db87`; protocol 7, guest protocol 3,
  completion identity `b9412dc3af9b5eae8859f0fce56ce4db5b0e1163` and guest identity
  `1f7649a81c99c671770d3ef2bc09480dadd93847` remain matched. Helm reconciliation
  preserved those image values; no native/guest rebuild was needed.

## Cutover and development cleanup

The owner explicitly permitted discarding old development data. There were no
Sessions/Runs to migrate or back up. Accounts, model configuration and provider
credentials remain configured. Web/SSH access, Workers and Control Plane were
drained; the Volume Gateway was stopped before its `Recreate` upgrade.

Two pre-allocation-protocol failed-test records had already closed admission but
lacked a recoverable allocation identity. With all issuers stopped, Cube's full
node inventory confirmed **0 sandboxes on 1/1 nodes**. For their two exact
Workspace IDs, the Gateway prepared deletion, Cube's managed Volume delete
confirmed absence, and the Gateway finalized the envelopes. Only then were the
two obsolete PG runtime records removed. No UNKNOWN record was relabeled as a
successful normal runtime recovery. This is an owner-authorized development
cleanup, not a new runtime rule allowing missing heartbeats to release resources.

The 86 already-released historical runtime records were discarded. After live
acceptance, its three released runtime records were also removed once their
Workspace purge completed. Final evidence shows zero Sessions, Runs, pending
Outbox rows, runtime records, live Cube sandboxes and Cube Volumes. No old
conversation backup or compatibility data path was introduced.

## Actual-image and live verification

All seven newly built application/provider images have the expected full source
revision and pass the repository's **zero fixable HIGH/CRITICAL** vulnerability
gate. Raw OS findings without available fixes remain visible; this is not a
zero-vulnerability claim. The private raw scan set is
`dist/release-evidence-review-release-8244934a`. Unchanged native Cube and Guest
images retain their previously recorded matching evidence, not a claimed new scan.

All live model checks use **GPT-6 Luna** and owned disposable resources:

- [Browser retry and upload concurrency](review-release-retry-upload-20261007.json):
  the real API commits a browser submission, then the browser fixture discards
  its successful response. Retrying yields two requests, one key, one Run and
  a server-confirmed replay. While a 1 MiB upload is paused after 64 KiB has reached
  its real Volume temporary file, directory browsing and a second upload finish
  in about **104 ms**, before the first upload resumes.
- [Native Tools](review-release-tools-20261007.json): write and Bash execute through
  Cube, exact file bytes/hash are verified, and both native execute checkpoints
  are present. No Tool-call draft appears in native documents.
- [Images and replacement Worker](review-release-uploads-20261007.json): the deployed
  browser uploads six files totaling **60,863,042 bytes**, including a
  **24,162,882-byte** PNG. Luna identifies its visual code without a read Tool.
  The native image-bearing record is **1,766 bytes**. Read/Bash and a direct file
  read confirm that the Workspace image was replaced with `changed`, while the
  immutable attachment retains its original hash. After replacing the owning
  Worker, another Worker answers a previously unasked visual ordering question
  from the retained original image, without Tools.

The first image attempt passed upload/direct vision but the model omitted the
second requested Tool in a compound read/Bash instruction. The exact Tool assertion
failed, and that attempt did not reach cold recovery. The fixture now requests
read and mutation in separate Turns and additionally verifies physical file bytes;
the complete rerun passes. No production runtime behavior was changed to pass it.

The two acceptance-script changes and documentation are a follow-up to the deployed
source revision; they do not require another application rollout. Single-host
acceptance does not establish physical multi-node filesystem recovery or HA.
