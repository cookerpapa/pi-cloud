# Cubelet → guest review probes

These reproduce the observations in the
[October 15 review](../../../docs/reports/cubelet-guest-execution-review-20261015.md)
against the checked-in native patch set and installed Pi Durable 1.0.0.
They deliberately assert current defects; passing is reproduction evidence, not
successful repair acceptance.

From the repository root with installed npm dependencies, Go with automatic
toolchain selection, and a local CubeSandbox Git checkout containing the pinned
commit:

```sh
node --import tsx scripts/experiments/review-20261015-guest/run.mjs /tmp/pi-cloud-guest-review-results.json
```

`PI_CLOUD_CUBESANDBOX_REPOSITORY` overrides `~/CubeSandbox`;
`PI_CLOUD_GOPROXY` overrides the dependency download mirror. The operator checkout
is exported by commit, never edited. Source patch digests are verified before
application in an owned temporary directory, which is removed on completion.

The runner compares native/cloud paths, checks default attachment fields, runs
the native execution baseline with `-race`, and injects an expired setup and a
stalled cleanup Kill through the existing containerd interface. It requires no
Cube VM, Kafka, PG, provider credentials or model request. It touches only fixture
files, temporary source and normal language dependency/build caches.

The expired-setup probe observes a fixed launcher Start. It does not claim that
the cancelled request reaches Bash. The stalled-Kill fixture is explicitly released
after observing the missing deadline, so it leaves no blocked test goroutine.
