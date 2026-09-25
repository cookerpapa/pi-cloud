# PiCloud

A self-hosted, multi-tenant coding agent. Pi SDK runs the Agent Loop in a shared
Worker pool; file and shell tools execute in isolated CubeSandbox KVM guests.

- Multi-round chat, model switching, hosted search and Subagents.
- Persistent conversations, context compaction and interruption recovery.
- Elastic Workspaces or dedicated development machines, with file browsing,
  terminals and app previews. Dedicated machines also support SSH.

## Architecture

```text
Browser -> Control Plane -> PostgreSQL queue -> Pi Worker
Pi Worker <-> CLIProxyAPI <-> Model

Pi Worker -> Kafka -> Session Projector
                      +-> PostgreSQL (conversation history)
                      +-> Browser (SSE)
                      `-> Tool Broker -> CubeSandbox
```

Whole file/shell Tools execute in Cube. Final results return through Kafka to
Pi Worker; optional temporary logs go directly through Projector to the browser.
Workspace files live on persistent Cube Volumes.
The API and Projector share the Control Plane process. Outputs are persisted
before display, except disposable Tool log previews. Recovery never automatically
replays uncertain commands.

## Quick start

Requires x86_64 Debian/Ubuntu or WSL2 with systemd, writable `/dev/kvm`,
at least 16 GiB RAM and 40 GiB free disk. Intended for private deployments.

```bash
./install.sh --check-only
./install.sh
```

1. Open `http://127.0.0.1:8080` and register an account.
2. Promote your administrator account (restarts Control Plane):

   ```bash
   npm run production:administrator -- --username <username>
   ```

3. Open `http://127.0.0.1:8081` to configure model routes and Cube networking.
   Add model credentials through the linked Provider Gateway; its management key
   is available with `npm run production:provider-gateway:key`.
4. Return to the chat page, create a Workspace and send a task. For a dedicated
   machine, request one under **开发资源** first. Pure chat needs no sandbox.

Configuration and secrets are stored in the private `deploy/production/runtime/`
directory. For upgrades, public access or Kubernetes, follow the guides below.

## Documentation

[Deployment & upgrades](docs/PRODUCTION_DEPLOYMENT.md) ·
[Configuration](docs/CONFIGURATION.md) · [Kubernetes](docs/DISTRIBUTED_DEPLOYMENT.md) ·
[Architecture](docs/ARCHITECTURE.md) · [Tests](docs/EVALUATION.md) ·
[More docs](docs/README.md)
