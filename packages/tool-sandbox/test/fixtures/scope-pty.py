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
master, slave = os.openpty()
child = subprocess.Popen(
    [node, scope, "run", operation_id], stdin=slave, stdout=slave, stderr=slave,
    env={**os.environ, "REVIEW_FINISHED": str(finished)},
)
os.close(slave)
pending = b""
frames = []
final = None
started = time.monotonic()
try:
    while time.monotonic() - started < 12:
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
            elif frame.get("type") == "worker.operation_result":
                final = frame
                if mode in ("true", "child-reserved"):
                    os.write(master, b'{"type":"scope.received"}\n')
                elif mode == "invalid":
                    os.write(master, b'{"type":"scope.received","extra":true}\n')
    code = child.wait(timeout=1)
    pathlib.Path(directory, "scope-" + mode + ".jsonl").write_text("\n".join(frames) + "\n")
    print(json.dumps({
        "acknowledged": mode in ("true", "child-reserved"), "exitCode": code,
        "finalSucceeded": bool(final and not final["response"]["event"]["isError"]),
        "localFinishCompleted": finished.exists(),
        "scopeStopRequired": final["scopeStopRequired"] if final else None,
        "elapsedMs": round((time.monotonic() - started) * 1000),
        "scopeFailureText": any(line.strip() == "cube_execution_scope_failed" for line in frames),
    }))
finally:
    os.close(master)
    if child.poll() is None:
        child.kill()
    child.wait()
