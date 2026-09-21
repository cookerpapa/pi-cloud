# Assistant presentation — September 21, 2026

Implementation and deployed Worker/Control Plane/Web: `e301418a`.
Pi 0.84.1, PostgreSQL schema 147, Kafka v10 and Cube template `f9ebe6af` unchanged.
Implements [ADR-0182](../adr/0182-assistant-message-presentation.md).

## Behavior and boundary

Verified GPT Responses commentary is published as one complete text span at Pi
text_end, then displayed without typing animation. Final-answer text continues
streaming immediately with the existing bounded 25ms adjacent-text coalescer.
Tool preparation, execution and hosted-search progress remain visible.

The Worker-local Gateway's existing SSE observer records only response/text-item
phase metadata before forwarding the original bytes. The Runner consumes it
through a lease-local resolver and Pi's public events. No Agent Loop or dependency
source was patched. Original Pi messages/signatures and replay remain unchanged.
Text spans carry optional phase through Kafka, live projection, native history
reads and the UI. Adjacent commentary/final spans cannot be merged accidentally.
There is no new PG query, network hop or persistence barrier on this path.

The actual DeepSeek Pro route is **not eligible** for early classification: a
two-request Tool probe returned final_answer on message creation but commentary
on completion before the Tool call. Its final reply stayed final_answer. GPT
Luna supplied stable commentary/final_answer at creation and completion.
DeepSeek therefore retains its existing streaming behavior; there is no prose
heuristic, fabricated phase or delayed replay advertised as real streaming.
Future routes without reliable early metadata likewise remain unclassified.

Commentary intentionally becomes visible at block completion, not its first raw
provider token. The existing transport firstTextMs measures that raw token;
its gap to first displayed commentary includes provider generation time, not
only internal relay latency. This report makes no TTFT speedup claim.

## Tests

- Full package suite with an isolated PostgreSQL: **1,132 passed, zero failed**,
  177 files. Three explicit external opt-ins remained skipped (Kafka topic policy,
  two Cube provider security checks); they are not counted as passes.
- Maintained fault gate: **34/34 passed** with the isolated PostgreSQL configured.
  The initial invocation omitted its PG URL and correctly failed the skipped
  database-dependent cases; those results were not counted as passes.
- Real Pi Responses adapter test covers fragmented SSE, mixed reasoning/search/
  text indices, whole commentary, incremental final text and native signature
  preservation. Unknown phases and interrupted commentary are covered.
- Gateway tests cover per-lease isolation, release cleanup and excluding the
  unverified DeepSeek route. The Runner test holds a commentary ACK and proves
  final publication waits, then proves final text arrives before response completion.
- Native transcript, live reducer and compact-tail tests preserve phase boundaries;
  covering old spans does not mutate an already-captured snapshot.
- Browser presentation regression renders whole commentary without advancing any
  animation frame, while retaining progressive final output and reconnect behavior.
- Typecheck, formatting, build, documentation and image-closure checks passed.
  The existing Web bundle-size warning remains; no dependency was upgraded.

The new Runner fixture initially triggered Compaction because its default context
window equalled the reserve. The fixture was corrected to the normal large-window
settings; production Compaction was not changed to make the test pass.

## Real provider and product acceptance

Normal cookie login/API/SSE paths used two owned test tenants. Real Cube executed
the programming commands; no mocked Tools were counted as coding acceptance.

| Run scenario | Whole commentary blocks | Streaming final chunks | Result |
| --- | ---: | ---: | --- |
| Luna: insertion sort + actual Python tests | 1 | 35 | passed |
| Luna: binary search + both Python test suites | 1 | 29 | passed; original file byte-identical |
| Luna: hosted search of Python bisect documentation | 1 | 47 | passed; one search, citation/history retained |
| DeepSeek Pro after GPT history | unclassified | 55 unclassified text chunks | passed; original stream retained |
| Back to Luna, cancel during final answer | 1 | 15 | 144 visible characters retained exactly |
| Two-tenant concurrent Tool conversations | 1 each | 10 / 16 | passed; independent output |

Every checked Run's API history and a newly opened SSE snapshot matched the
observed text exactly, including the cancelled prefix. Functional observers saw
zero unexpected reconnects. The next ordinary Run after cancellation succeeded.

An additional real Chrome test used the default-family **GPT-5.6 Sol**: one
commentary block appeared at full length, with one observed text version; its
217-character final answer had **70 progressive render updates**. Reloading the
explicit Session URL preserved the final text exactly.

There were nine product Runs: eight completed and one deliberately cancelled.
One extra completed Run came from a cancellation fixture asking for 2,000 lines:
the model printed them via Bash and returned only 102 characters, below that
fixture's 120-character cancellation trigger. The probe was stopped after the
Run completed, then repeated with explicit in-answer prose and a smaller trigger.
This was a test-prompt/threshold issue, not a dropped answer or product retry.

Native assistant records across the product tests reported **52,812 input,
156,160 cache-read and 4,234 output tokens**, across 19 assistant records.
Four additional direct provider requests established the raw phase behavior.
These are real-token checks, not synthetic token-count estimates.

## Deployment and cleanup

Matching Worker/Control Plane/Web were replaced only after zero active/unsealed
Runs and current Session owners were confirmed. PG, Kafka, Broker and Cube were
not restarted; no migration or template rebuild was needed. Existing browser
tabs need a normal refresh to load the new rendering bundle.

Fixtures were two tenants, three Sessions, two elastic Workspaces and no dedicated
machines. Product deletion and physical storage purge completed, followed by
removal of only registered test-tenant rows. Cube inventory and the shared Volume
directory are empty. Original native history retained its checksum; counts remain
33 tenants, 35 users, one Session, one released Workspace and seven Runs.
Temporary test PG and private scripts/raw evidence are removed after verification;
the aggregate evidence remains here. Shared production logs/Kafka retention are
not globally wiped.

This acceptance does not claim DeepSeek final-only streaming, a full new product
audit, new enterprise capacity measurements or a new physical-node failure test.
