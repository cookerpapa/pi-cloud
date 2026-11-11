#!/usr/bin/env python3
"""Operator-only BoxLite 0.12 adapter for the unchanged fixed Guest.

The subprocess owns an SDK connection, not the VM's lifetime. Requests use stdin;
no callback capability or Tool body is placed in process arguments. No upstream
code is modified. This is deliberately not a production SandboxProvider.
"""
import asyncio
import importlib.metadata
import json
import os
import sys
from pathlib import Path

import boxlite

VERSION = "0.12.0"
MAX_CONTROL = 8192


async def output(execution, maximum=MAX_CONTROL):
    async def read(source):
        data = ""
        async for part in source:
            data += part
            if len(data.encode()) > maximum:
                raise RuntimeError("Provider control output exceeded its bound")
        return data
    stdout, stderr, result = await asyncio.gather(
        read(execution.stdout()), read(execution.stderr()), execution.wait())
    return {"stdout": stdout, "stderr": stderr, "exitCode": result.exit_code}


class GuestAdapter:
    def __init__(self, directory, image, registry):
        assert importlib.metadata.version("boxlite") == VERSION
        self.directory = Path(directory).resolve()
        assert (self.directory / ".pma-boxlite-guest").read_text() == VERSION
        self.image = image
        assert "@sha256:" in image and image.startswith(registry + "/")
        self.runtime = boxlite.Boxlite(boxlite.Options(
            home_dir=str(self.directory / "runtime"),
            # The existing private fixture registry uses a self-signed cert.
            # Artifact identity remains pinned to the verified OCI digest.
            image_registries=[boxlite.ImageRegistry(registry, transport="https", skip_verify=True)]))

    async def box(self, identity):
        # Never get-or-create: unknown identity must not cause execution replay.
        value = await self.runtime.get(identity)
        if value is None:
            raise RuntimeError("Recorded BoxLite identity is unavailable")
        return value

    async def call(self, request):
        action = request["action"]
        if action == "create":
            # SDK create identity is recorded before Guest initialization.
            # Never retry an uncertain creation in this owned namespace.
            if (self.directory / "creation-issued").exists():
                raise RuntimeError("Creation already issued; inspect native inventory")
            (self.directory / "creation-issued").touch(exist_ok=False)
            workspace = self.directory / "workspace"
            workspace.mkdir(exist_ok=True)
            box = await self.runtime.create(boxlite.BoxOptions(
                image=self.image, cpus=1, memory_mib=1024, disk_size_gb=8,
                user="0:0", entrypoint=["/bin/sleep"], cmd=["infinity"],
                # This exposes the VM's own cgroup tree to the trusted Guest
                # supervisor. It does not grant host privilege; Tools drop to
                # UID 1000 with no-new-privileges inside that VM.
                advanced=boxlite.AdvancedBoxOptions(privileged=True,
                    security=boxlite.SecurityOptions(jailer_enabled=False, seccomp_enabled=True)
                    if os.environ.get("PMA_BOXLITE_ROOTFUL_PROBE") == "1" and os.geteuid() == 0
                    else None),
                detach=True, auto_delete=0,
                volumes=[(str(workspace), "/workspace", False)]))
            (self.directory / "identity.json").write_text(json.dumps({"boxId": box.id}))
            await box.start()
            return {"boxId": box.id}
        if action == "inventory":
            return [{"boxId": v.id, "state": str(v.state.status)} for v in await self.runtime.list_info()]
        box = await self.box(request["boxId"])
        if action == "info":
            return {"boxId": box.id, "state": str((await box.info()).state.status)}
        if action in ("stop", "start"):
            await getattr(box, action)()
            return {"confirmed": True}
        if action == "remove":
            # Native forced removal ignores a stop-handler error. Prefer the
            # awaited Guest shutdown, then non-force metadata removal.
            await box.stop()
            await self.runtime.remove(box.id, force=False)
            assert await self.runtime.get(box.id) is None
            return {"absent": True}
        if action == "guest":
            execution = await box.exec("node", ["/opt/pi-cloud/bin/guest-executor-client.mjs"], user="0:0")
            stream = execution.stdin()
            await stream.send_input((json.dumps(request["request"]) + "\n").encode())
            await stream.close()
            result = await output(execution)
            if result["exitCode"] != 0:
                raise RuntimeError("Guest control failed: " + result["stdout"][-512:])
            lines = result["stdout"].splitlines()
            assert lines[0] == "PI_CLOUD_GUEST_READY"
            return json.loads(lines[-1])
        if action == "inspect":
            # Trusted acceptance diagnostics only, never a public Tool endpoint.
            execution = await box.exec(request["command"], request.get("args", []), user="0:0")
            return await output(execution)
        raise ValueError("Unknown adapter action")


async def main():
    adapter = GuestAdapter(*sys.argv[1:4])
    for line in sys.stdin:
        try:
            value = await adapter.call(json.loads(line))
            print(json.dumps({"ok": True, "value": value}), flush=True)
        except Exception as error:
            print(json.dumps({"ok": False, "type": type(error).__name__, "message": str(error)[:1024]}), flush=True)
    # No runtime.shutdown: detach means a replacement adapter can reconnect.


if __name__ == "__main__":
    asyncio.run(main())
