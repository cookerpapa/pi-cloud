# Model request / response review experiments

These fixtures characterize the reviewed implementation; they do not require
provider credentials, Kafka, PostgreSQL or Cube. They bind owned loopback ports,
use synthetic upstream responses and close their Gateways/native Harnesses.
They never send a request to the fixture's placeholder provider URL.

From the repository root after installing the pinned dependencies:

```sh
node --import tsx scripts/experiments/review-model-branch-20261019/probe.mjs /tmp/pi-cloud-model-branch-review.json
```

The 12 cases cover real Pi provider parsing and scoped Models calls, native
Harness retry behavior, reasoning/text phase indexes, interrupted completed
hosted searches, and a terminal response before HTTP EOF. Some assertions
deliberately describe defects at review revision `3625350f`; replace them with
correct-behavior regressions when implementing the approved repair.

Run the existing related tests:

```sh
npx vitest run packages/supervisor-host/test/model-gateway.test.ts packages/supervisor-host/test/family-model-permits.test.ts packages/supervisor-host/test/responses-hosted-activity.test.ts packages/sandbox-supervisor/test/durable-scoped-models.test.ts packages/sandbox-supervisor/test/durable-model-registry.test.ts packages/sandbox-supervisor/test/model-request-policy.test.ts packages/sandbox-supervisor/test/pi-sampling-step.test.ts packages/sandbox-supervisor/test/provider-hosted-tools.test.ts packages/sandbox-supervisor/test/provider-hosted-transcript.test.ts scripts/lib/model-retry-policy.test.mjs --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000
npx vitest run packages/sandbox-supervisor/test/durable-tool-call-publication.test.ts packages/sandbox-supervisor/test/durable-compaction-recovery.test.ts packages/sandbox-supervisor/test/durable-text-presentation.test.ts packages/sandbox-supervisor/test/durable-agent-session.test.ts packages/sandbox-supervisor/test/durable-turn-runner.test.ts packages/fake-model-server/test/pi-openai-contract.test.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000
```

The review additionally ran the following in a clean CLIProxyAPI checkout at
the Dockerfile's pinned revision `48549e65b86d17648029190331807b89e7fd65f4`:

```sh
go test -json ./internal/runtime/executor ./sdk/api/handlers ./sdk/cliproxy/auth -run '^(TestCodexExecutorExecuteStream(MissingCompletionIsRequestScoped|ExplicitTerminalFailureIsNotSuccessful|IgnoresTransportErrorAfterCompletion|SurfacesTerminalStreamError)|TestCodexExecutorTransportFailureBeforeTerminalIsRequestScoped|TestOpenAICompatExecutorResponsesStream(FailsOnEOFWithoutDone|PreservesUpstreamDataError|PreservesNamedErrorEvent|HandlesAdditionalErrorShapes)|TestForwardStreamNormalizesErrorBeforeWriteAndCancel|TestExecuteRetryRoundCredentialWindows|TestExecuteSnapshotsDefaultRequestRetry)$' -count=1 -timeout=90s
```

The local tests use Go 1.26.0 from that checkout's module requirements. They are
source contract evidence, not a reproduction of every production image build.
The aggregate report contains no credentials or real conversation transcripts.
