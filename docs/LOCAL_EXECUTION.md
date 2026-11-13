# Local Linux execution

Issue #38 / ADR-0322 adds an explicitly connected local Linux project while the
Pi Harness remains in cloud Workers. This is an operator integration, not a
desktop application or a Windows/macOS executor. Publication/live acceptance is
tracked separately from source verification in BACKLOG.

The same Session can be read through the [shared client](SESSION_CLIENT.md) or
the web application. Closing a chat connection does not stop the local service.
The local connector opens an outbound WebSocket to the optional device-link
gateway. The gateway forwards only the existing inspect/admit/cancel/revoke
contract; scoped HTTPS completion goes directly to the cloud callback endpoint.
It never queues or replays Tool commands after reconnection.

## Runtime and directory boundary

The supported launcher requires Linux, Node satisfying the repository engine
requirement, and Bubblewrap **0.9.0** with working unprivileged namespaces. Run
`npm ci` in a clean checkout. The launcher mounts the explicitly selected project
at `/workspace`, supplies read-only fixed runtime files and a temporary directory,
and starts one persistent receiver namespace. The host root/home, Docker socket,
PG/Kafka credentials and cloud management token are not mounted. Network access
uses the user's host network; this is an explicit namespace boundary, not KVM
isolation or a transparent replacement for cloud provider policy.

`local_read`, `local_write`, `local_edit` and `local_bash` use the fixed Pi Tool
implementation, including source output bounds and normal process-group abort.
Image reads use the existing retained-image completion path. Shell deadlines
follow the existing maximum five-minute Tool budget, with a separate reply
delivery margin; they are not a total Agent Run limit. Background applications
survive ordinary Tool completion while the receiver namespace stays alive.
Explicitly stopping the local service ends that namespace and its processes.

Selecting this Linux target hides cloud Workspace tools for that Run. Cloud
Workspace files and uploads are not copied into the local project. Existing
chat image attachments still enter model context directly. Children do not
inherit device control; selecting a device creates no local/cloud file sync.
User-owned targets have no managed VM expiry, deletion or compute charge.

## Operator setup

Build/scan and install the optional cloud transport using the maintained helper:

```sh
node scripts/run-device-link-release.mjs prepare PRIVATE_RELEASE_DIR VERSION
node scripts/run-device-link-release.mjs apply PRIVATE_RELEASE_DIR
```

The matching Web ingress forwards `/v1/device-links/*` to this service. Use a
TLS-terminated public origin for remote devices. Plain WebSocket is permitted
only for a loopback development connection. This transport has a single gateway
replica in the initial operator integration; replication needs explicit device
connection routing, not a claim of fleet HA.

Configure a device-reachable HTTPS result endpoint as well as WSS. Set
`PI_CLOUD_DEVICE_COMPLETION_ADDRESS` to a verified routable IP and optionally
`PI_CLOUD_DEVICE_COMPLETION_PORT` (default 30432) in the deployment configuration.
The matched chart exposes the existing completion service through a NodePort;
it does not add a completion queue or result store. The default TLS server name
remains `tool-completion`, with the existing CA supplied in the scoped capability;
the explicit address controls where the device connects. Custom
`PI_CLOUD_DEVICE_COMPLETION_URL` must match the deployed certificate and use
`/v1/completions`. `PI_CLOUD_DEVICE_COMPLETION_CLIENT_CIDRS` is a JSON array for
the authenticated ingress. Private-network defaults do not assert Internet reachability.
Configure external routing/firewall/TLS as appropriate and retain an old endpoint
while its accepted operations can still complete. Outbound dispatch without this
configuration fails before sending a command, rather than running it with an
unreachable cluster-only callback.

Provision one random UUID and a random token of at least 32 characters for the
device. The private `secrets/device-link-devices.json` is a map from UUID to token;
its matching Kubernetes Secret is `pi-cloud-device-link-credentials` with the
`devices.json` key. The service reads this map on new connections. Keep the
operator's local file and Kubernetes Secret synchronized; never publish either.
These keys grant a device link, not ownership of a tenant or Session.

On the user computer, save the link token and a **different** random local
receiver token in private files. Neither is the platform management token.
The local configuration is:

```json
{
  "targetId": "DEVICE_UUID",
  "project": "/absolute/path/to/project",
  "port": 19181,
  "gatewayUrl": "wss://agents.example.com/v1/device-links/DEVICE_UUID",
  "deviceTokenFile": "/private/device-token",
  "receiverTokenFile": "/private/receiver-token"
}
```

Start from the checkout with `npm run local:connect -- /private/local-device.json`. The local receiver listens only on loopback; the
connector supplies the local receiver token and keeps cloud credentials off the
user device. Inspect the bounded `local_executor_ready` and `local_device_link`
operational messages rather than assuming that process startup means connectivity.

Once connected, the administrator registers the existing device for its explicit
organization using the Resources administration page or the existing registration
API. The private endpoint is `http://device-link:8090/targets/DEVICE_UUID`.
Registration verifies the receiver's actual identity, kind and capabilities;
it creates no VM. Bind an idle conversation from Resources. Binding conflicts
retain the existing Session revision/ownership checks.

## Failure behavior

A disconnected link rejects new handoffs. A lost in-flight admission remains
uncertain; reconnect does not re-send it. Receiver restart creates a new boot
identity and cannot revive an old operation. A Worker replacement restores the
original reply reference/deadline and exact cancellation target. Late replies
cannot overwrite a settled native abort. The gateway never stores Tool results.

Deleting a registration or terminating the connector does not delete project
files. Existing admission/closure rules still apply before unbinding/removing
the target. Optional gateway publication is independent of physical VM cleanup.
