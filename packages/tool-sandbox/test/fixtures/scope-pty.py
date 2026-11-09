"""Real terminal I/O; no VM, cgroup or production resource is modified."""
import errno
import json
import os
import pathlib
import select
import subprocess
import sys
import time

node, scope, payload_path, mode, directory = sys.argv[1:]
payload = json.loads(pathlib.Path(payload_path).read_text())
operation_id = payload["request"]["operationId"]
finished = pathlib.Path(directory) / ("finished-" + mode)
progress = pathlib.Path(directory) / ("progress-" + mode)
closed = False
master, slave = os.openpty()
child = subprocess.Popen(
    [node, scope, "run", operation_id], stdin=slave, stdout=slave, stderr=slave,
    env={**os.environ, "REVIEW_FINISHED": str(finished), "REVIEW_RESULT": str(pathlib.Path(directory) / ("result-" + mode)), "REVIEW_MODE": mode, "REVIEW_PROGRESS": str(progress)},
)
os.close(slave)
pending = b""
frames = []
final = None
started = time.monotonic()
try:
    while time.monotonic() - started < 12:
        if mode == "false" and pathlib.Path(directory, "execution-started").exists():
            assert not pathlib.Path(directory, "execution-finished").exists(), "caller did not exit during execution"
            os.close(master)
            closed = True
            break
        ready, _, _ = select.select([master], [], [], 0.1)
        if not ready:
            if child.poll() is not None:
                break
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError as exc:
            if exc.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            frames.append(line.decode())
            try:
                frame = json.loads(line)
            except ValueError:
                continue
            if frame.get("type") == "scope.ready":
                os.write(master, json.dumps(payload).encode() + b"\n")
            elif frame.get("type") == "worker.delivery_result":
                final = frame
    code = child.wait(timeout=5)
    pathlib.Path(directory, "scope-" + mode + ".jsonl").write_text("\n".join(frames) + "\n")
    print(json.dumps({
        "acknowledged": mode in ("true", "child-reserved"), "exitCode": code,
        "finalSucceeded": bool(final and final["delivered"]),
        "localFinishCompleted": finished.exists(),
        "executionComplete": final["executionComplete"] if final else None,
        "elapsedMs": round((time.monotonic() - started) * 1000),
        "scopeFailureText": any(line.strip() == "cube_execution_scope_failed" for line in frames),
    }))
finally:
    if not closed:
        os.close(master)
    if child.poll() is None:
        child.kill()
    child.wait()
