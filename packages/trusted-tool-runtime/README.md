# Trusted Tool Runtime

This package supplies execution-plane-tagged Tool facades to the trusted Agent
Host and PostgreSQL Subagent admission/delivery stores to the Projector:

- `platform`: verified Preview publication;
- `orchestration`: log-published Subagent control and parent/child communication;
- `integration`: reserved for future external-system effects.

The Worker only freezes native Lane context and appends commands. The Projector
admits children and delivers controls; it never runs model-generated JavaScript.
Its dedicated store exports do not import the Worker's Pi Tool adapter graph.
Workflow scripts run in Cube and use a bounded duplex bridge back to the same
Worker log writer. There is no CLI emulation or additional SessionManager.
Cube-backed `read`, `write`, `edit` and `bash` remain owned by Tool Broker;
Provider-hosted capabilities remain owned by the model Provider.

See [the Subagent contract](../../docs/SUBAGENTS.md).
