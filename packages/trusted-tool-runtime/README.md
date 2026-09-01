# Trusted Tool Runtime

This package owns PiCloud function Tools that must not execute in CubeSandbox.
It supplies execution-plane-tagged Tool definitions to the trusted Agent Host:

- `platform`: verified Preview publication;
- `orchestration`: Subagent dispatch and durable parent/child communication;
- `integration`: reserved for future external-system effects.

The current implementation is an in-process PostgreSQL module, not another
service. Cube-backed `read`, `write`, `edit` and `bash` remain owned by Tool
Broker, while Provider-hosted capabilities remain owned by the model Provider.
