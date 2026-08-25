# Structured Sandbox Preview

## Public evidence

OpenAI's public material confirms the product outcome—Codex/ChatGPT can build a
browser application, test it in a live browser and produce a live preview—but
does not disclose ChatGPT Work's internal listener-discovery or routing
protocol. PiCloud therefore treats any more detailed description of OpenAI's
implementation as unknown rather than reverse-engineering a claim from UI
behavior.

- [OpenAI: ChatGPT and Codex use cases](https://learn.chatgpt.com/use-cases)

Open-source and documented Sandbox platforms converge on a platform-owned port
mapping:

- [E2B `getHost(port)`](https://e2b.dev/docs/sdk-reference/js-sdk/v2.2.0/sandbox)
  derives a Sandbox host for an explicit port.
- [Daytona `getPreviewLink` and signed Preview URLs](https://www.daytona.io/docs/en/typescript-sdk/sandbox/)
  return proxy-owned URLs, including access tokens for private Sandboxes.
- [Daytona's Coding Agent guide](https://www.daytona.io/docs/en/guides/copilotkit/copilotkit-generative-ui-coding-agent-sandbox/)
  uses a typed `startWebServer` Tool, waits for readiness and renders the
  structured result as an iframe.
- [OpenHands Runtime](https://github.com/OpenHands/docs/blob/main/openhands/usage/architecture/runtime.mdx)
  allocates locked application-port ranges and forms URLs from runtime state.
- [Vercel Sandbox](https://vercel.com/sandbox) exposes bounded ports through
  `sandbox.domain(port)`.
- [Vercel Open Agents](https://github.com/vercel-labs/open-agents) keeps the
  Agent outside the Sandbox and treats preview ports as Sandbox infrastructure.

## PiCloud decision

Prompt instructions remain useful for asking applications to bind `0.0.0.0`,
but natural language is not a service-discovery contract. PiCloud uses this
pipeline instead:

```text
Bash completes inside Cube
  -> Cube Provider runs a fixed credential-free probe over its management channel
  -> probe reads /proc/net/tcp{,6}
  -> bounded HTTP readiness probes
  -> structured listeningPorts/httpServices Tool result
  -> Tool Broker persists runtime + target + port
  -> Control Plane returns tenant-scoped service resources
  -> Web renders Open application links
  -> Preview Gateway signs and proxies the selected target
```

The model sees neither the service registry identity nor routing credentials.
It reports the verified port only. The registry is replaceable runtime state:
changing physical runtime or observing a closed listener ends the old service,
while a repeated observation upserts the same runtime-port identity.
