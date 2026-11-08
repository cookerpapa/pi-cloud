#!/usr/bin/env python3
"""Isolated BoxLite 0.12.0 capability probe, never a production backend.

Run only in the combined serial verification phase. Install boxlite==0.12.0
in a disposable venv and supply an OCI image pinned by digest. The only mount
is a fresh directory owned by this probe; retain evidence if cleanup fails.
"""
import asyncio
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import time

VERSION = "0.12.0"


async def collect(execution):
    async def stream(source):
        chunks = []
        size = 0
        async for chunk in source:
            size += len(chunk.encode())
            if size > 65536:
                raise AssertionError("Guest failed source output bound")
            chunks.append(chunk)
        return "".join(chunks)
    output, errors, result = await asyncio.gather(
        stream(execution.stdout()), stream(execution.stderr()), execution.wait())
    return output, errors, result


async def run(directory, image, crash_child=False):
    import boxlite
    assert importlib.metadata.version("boxlite") == VERSION
    runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(directory / "runtime")))
    shared = directory / "workspace"
    shared.mkdir(exist_ok=True)
    identity_file = directory / "identity.json"
    report = {"version": VERSION, "image": image, "accepted": False, "cleanupConfirmed": False}
    owned_id = None
    if crash_child:
        box = await runtime.create(boxlite.BoxOptions(image=image, memory_mib=512, cpus=1,
            cmd=["sleep", "300"], auto_remove=False, volumes=[(str(shared), "/workspace", False)]))
        identity_file.write_text(json.dumps({"boxId": box.id, "executionId": None}))
        try:
            await box.start()
            execution = await box.exec("sh", ["-c", "echo once >> /workspace/effects; sleep 30; echo done > /workspace/finished"])
            identity_file.write_text(json.dumps({"boxId": box.id, "executionId": execution.id()}))
            for _ in range(100):
                if (shared / "effects").exists():
                    os._exit(0)  # deliberate caller death, not guest command replay
                await asyncio.sleep(.05)
            raise RuntimeError("Guest effect did not start")
        finally:
            await runtime.remove(box.id, force=True)
            await runtime.shutdown(timeout=5)
    try:
        identity = json.loads(identity_file.read_text())
        owned_id = identity["boxId"]
        box = await runtime.get(owned_id)
        report["callerExitState"] = str((await box.info()).state.status)
        try:
            control = await box.executions().get(identity["executionId"])
            await control.kill()
            await control.wait()
            report["handleRecovery"] = "control recovered; original operation cancelled"
        except Exception as error:
            report["handleRecovery"] = type(error).__name__
        assert (shared / "effects").read_text().splitlines() == ["once"]
        report["effectCountAfterCallerExit"] = 1
        await box.start()  # explicit recovery of this disposable evaluation box
        # A fixed guest harness owns truncation before the host sees the bytes.
        program = "import json; s='x'*200000; print(json.dumps({'content':s[-51200:],'truncated':len(s)>51200}))"
        started = time.monotonic()
        output, errors, result = await collect(await box.exec("python", ["-c", program]))
        body = json.loads(output)
        assert not errors and body["truncated"] and len(body["content"]) == 51200
        report["boundedReplyBytes"] = len(output.encode())
        report["warmExecutionMs"] = round((time.monotonic() - started) * 1000)
        output, errors, result = await collect(await box.exec("sh", ["-c", "echo retained > /root/pi-cloud-disk-marker; cat /workspace/effects"]))
        assert output.strip() == "once" and not errors
        await box.stop()
        box = await runtime.get(owned_id)
        await box.start()
        output, errors, result = await collect(await box.exec("cat", ["/root/pi-cloud-disk-marker"]))
        assert output.strip() == "retained" and not errors
        report["diskSurvivesStop"] = True
        report["accepted"] = True
    finally:
        try:
            if owned_id:
                await runtime.remove(owned_id, force=True)
                report["cleanupConfirmed"] = await runtime.get(owned_id) is None
        finally:
            try:
                await runtime.shutdown(timeout=5)
            finally:
                (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        if not report["cleanupConfirmed"]:
            raise RuntimeError("Keep the isolated directory: physical cleanup is unconfirmed")


async def failed_child_cleanup(directory):
    import boxlite
    assert (directory / ".pi-cloud-boxlite-evaluation").read_text() == VERSION
    runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(directory / "runtime")))
    try:
        # This namespace was exclusively created by this probe, including any
        # creation whose caller died before writing its handle to identity.json.
        for info in await runtime.list_info():
            await runtime.remove(info.id, force=True)
        assert not await runtime.list_info()
        (directory / "failed-probe-cleanup.json").write_text(json.dumps({"cleanupConfirmed": True}))
    finally:
        await runtime.shutdown(timeout=5)


if __name__ == "__main__":
    directory, image = Path(sys.argv[1]).resolve(), sys.argv[2]
    assert "@sha256:" in image, "Use a pinned OCI image"
    if len(sys.argv) > 3 and sys.argv[3] == "crash-child":
        asyncio.run(run(directory, image, True))
    else:
        directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        (directory / ".pi-cloud-boxlite-evaluation").write_text(VERSION)
        try:
            subprocess.run([sys.executable, __file__, str(directory), image, "crash-child"], check=True, timeout=240)
        except BaseException:
            asyncio.run(failed_child_cleanup(directory))
            raise
        asyncio.run(run(directory, image))
