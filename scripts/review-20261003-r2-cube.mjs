// Exercise the exact maintained Cube manager patches without starting a VM.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "pi-cloud-review-cube-"));
try {
  await exec("git", ["init", "--quiet"], { cwd: directory });
  for (const patch of ["0003-native-tool-execution.patch", "0004-execution-probes.patch"])
    await exec(
      "git",
      [
        "apply",
        "--include=Cubelet/pkg/execution/manager.go",
        "--include=Cubelet/pkg/execution/probe.go",
        join(root, "deploy/cubesandbox/patches", patch),
      ],
      { cwd: directory },
    );
  const cwd = join(directory, "Cubelet/pkg/execution");
  await writeFile(
    join(cwd, "go.mod"),
    "module reviewcube\n\ngo 1.24.0\n\nrequire github.com/google/uuid v1.6.0\n",
  );
  await writeFile(
    join(cwd, "review_test.go"),
    `package execution
import (
  "context"
  "testing"
  "time"
  "github.com/google/uuid"
)
func TestReviewRetiredRuntimeDoesNotRestoreAdmission(t *testing.T) {
  m := New(nil, nil)
  for i := 0; i <= maximumRetained; i++ {
    if err := m.Stop(context.Background(), m.BootID, "old-vm", uuid.NewString(), "", ""); err != nil { t.Fatal(err) }
  }
  if m.Accepting() { t.Fatal("expected current capacity behavior to close admission") }
  before := len(m.closedRuns)
  m.ForgetRuntime("old-vm")
  if len(m.closedRuns) != 0 { t.Fatal("old runtime tombstones were not removed") }
  code := m.Submit(m.BootID, Request{SandboxID:"new-vm", OperationID:uuid.NewString(), RunID:uuid.NewString(), WriterID:uuid.NewString(), Payload:[]byte("{}"), CompletionContext:[]byte("{}"), Timeout:time.Second, MaximumOutputBytes:1024})
  if code != "executor_capacity" { t.Fatalf("unexpected current behavior: %s", code) }
  t.Logf("review_characterization tombstonesBefore=%d tombstonesAfter=%d accepting=%v freshRuntimeResult=%s", before, len(m.closedRuns), m.Accepting(), code)
  m.Close()
}
`,
  );
  const result = await exec("go", ["test", "-mod=mod", "-v", "-count=1", "./..."], {
    cwd,
    timeout: 120_000,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} finally {
  await rm(directory, { recursive: true, force: true });
}
