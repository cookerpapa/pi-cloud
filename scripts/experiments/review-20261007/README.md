# October 7 repository review reproductions

The review characterizes revision `7a5fc6034a55d9fda98a25c8015112327ed2bfc4`.
These scripts now verify the repaired behavior; original measurements remain in
the [review report](../../../docs/reports/repository-review-20261007.md) and its
JSON. They are fixtures, not product implementations or a new runtime layer.

From the repository root, with dependencies installed:

```sh
node scripts/experiments/review-20261007/send-ack.mjs
node --import tsx scripts/experiments/review-20261007/gateway-lock.mjs
node --import tsx scripts/experiments/review-20261007/list-query.mjs
node scripts/experiments/review-20261007/guest-provenance.mjs
```

- `send-ack` uses the maintained browser fixture and actual ChatApp/PiCloudApi.
  The fixture accepts the first request and loses its response; retrying the
  unchanged draft must retain one key/admission. Chrome is required.
  Optional first argument: JSON output file.
- `gateway-lock` uses two actual Gateway objects, a real POSIX Volume fixture
  and filesystem flock. Directory listing must succeed during a suspended
  two-chunk upload. The test lock wait is 100 ms; production defaults to 30 s.
  Optional first argument: JSON output file.
- `list-query` creates and removes an isolated PostgreSQL container. It migrates
  a clean database, then copies current table definitions/indexes to an isolated
  fixture schema with 5,000 Sessions and 200,000 Turns. It captures the actual
  repaired ConversationReader query and compares it with the original query
  recorded in the review JSON. It asserts identical results and that only the
  current page's Turns are scanned. The schema copies omit foreign keys; this is a query measurement,
  not lifecycle load or a production capacity claim. Optional first argument:
  JSON output file. Docker is required.
- `guest-provenance` invokes the actual release image inspection function without
  running the release script. It reads a local guest image; the default reference
  uses the current guest input hash. Optional first argument: image reference;
  second argument: JSON output file. Use a guest image reused after a Git revision
  that does not change guest build inputs to verify retained source provenance.
  Docker and that prebuilt image are required. This probe does not build images,
  register templates, prune anything, or read runtime credentials.

The browser fixture tests client request identity; the backend's committed
`(session_id, idempotency_key)` replay lookup supplies the corresponding server
contract. Database timings are illustrative. None of these fixtures calls a model or writes
production data.
