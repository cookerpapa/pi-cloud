# DeepSeek V4.1 Flash: ordinary live use

Verified against `pilot-ready-81392f7d` on October 7, 2026, after the owner asked
for Flash acceptance without search. The selectable model is DeepSeek V4.1 Flash;
its request ID is `deepseek-v4-flash`. The configured CLIProxyAPI route uses
Responses and points to `api.deepseek.com`. Credentials and existing model
configuration were not changed.

[Bounded evidence](deepseek-flash-acceptance-20261007.json) records the native Turn
provider/model/thinking snapshots, Tool outcomes, timings and usage. A private
tenant and one owned Workspace exercise the ordinary API → Worker/Pi → model
gateway → provider path and actual Cube Tool execution.

| Check | Result | Elapsed time in this sample |
| --- | --- | --- |
| Text, thinking off | Exact synthetic marker returned, no Tool call | 1.10 s |
| File write and execution | Native write + Bash succeed; independent Workspace read verifies exact Python bytes | 6.46 s |
| Follow-up, thinking high | File modified and executed with additional assertions; prior conversation marker retained | 4.38 s |
| Attached image | Random six-digit PNG read directly and correctly, without an Agent Tool call; immutable image reference retained | 1.88 s |

All four Runs completed. No provider-hosted Tool call was recorded. Search was
neither requested nor evaluated; this does not update the older search findings.
Timings are single samples, not latency or availability guarantees. Large images,
long context, concurrency and fault recovery are outside this smoke test.

The initial driver used an absolute path with the relative-path Workspace browser
API after its text/Tool checks had already passed. That test error was corrected;
the final complete run passes. Both fixture attempts were cleaned through the
existing lifecycle and scoped cleanup helpers. Original accounts/model profiles
remain; no application redeployment was required.

Reproduce from the installed checkout:

```sh
PI_CLOUD_LIVE_DEEPSEEK_CHECK=1 node --import tsx scripts/run-live-deepseek-flash-check.mjs
```

This command uses real Flash tokens and an owned Cube Workspace. It emits bounded
private evidence under `dist/`, removes its Session/Workspace after sealing and
physical purge, then removes only its own account/image fixtures.
