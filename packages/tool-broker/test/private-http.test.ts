import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

it("keeps Broker health and authenticated RPC off the provider proxy", async () => {
  let proxyHits = 0;
  const paths: string[] = [];
  const target = createServer(async (request, response) => {
    paths.push(request.url!);
    response.setHeader("content-type", "application/json");
    if (request.url === "/health/ready" || request.url === "/proxy-control") {
      response.end(JSON.stringify({ status: "ready" }));
      return;
    }
    let bytes = "";
    for await (const chunk of request) bytes += String(chunk);
    const body = JSON.parse(bytes) as { requestId: string; workspaceId: string };
    response.end(
      JSON.stringify({
        sourceControlProtocolVersion: 1,
        type: "source_control.workspace_credential_listed",
        requestId: body.requestId,
        workspaceId: body.workspaceId,
        connections: [],
      }),
    );
  });
  const proxy = createServer((_request, response) => {
    proxyHits++;
    response.writeHead(502).end();
  });
  proxy.on("connect", (_request, socket) => {
    proxyHits++;
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  try {
    const baseUrl = await listen(target),
      proxyUrl = await listen(proxy);
    const code = `
      import {ToolBrokerClient} from ${JSON.stringify(new URL("../src/tool-broker-client.ts", import.meta.url).href)};
      import {HttpWorkspaceVolumeGateway} from ${JSON.stringify(new URL("../src/workspace-volume-gateway-transport.ts", import.meta.url).href)};
      const client=new ToolBrokerClient({baseUrl:${JSON.stringify(baseUrl)},serviceToken:'owned-fixture-private-token-0000000000',allowInsecureHttp:true,requestTimeoutMs:2000});
      await client.checkHealth();
      await new HttpWorkspaceVolumeGateway({baseUrl:${JSON.stringify(baseUrl)},serviceToken:'owned-fixture-private-token-0000000000'}).checkHealth();
      const result=await client.listSourceCredentials({sourceControlProtocolVersion:1,type:'source_control.workspace_credential_list',requestId:'10000000-0000-4000-8000-000000000001',tenantId:'tenant-fixture',workspaceId:'20000000-0000-4000-8000-000000000001',credentialMountPath:'/workspace'});
      let providerProxyStillUsed=false;
      try{providerProxyStillUsed=!(await fetch(${JSON.stringify(baseUrl)}+'/proxy-control',{signal:AbortSignal.timeout(2000)})).ok;}
      catch{providerProxyStillUsed=true;}
      console.log(JSON.stringify({connections:result.connections,providerProxyStillUsed}));
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        NO_PROXY: "",
        no_proxy: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      error = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (error += String(chunk)));
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(exit, error).toBe(0);
    expect(JSON.parse(output)).toEqual({ connections: [], providerProxyStillUsed: true });
    expect(proxyHits).toBe(1);
    expect(paths).toEqual(["/health/ready", "/health/ready", "/internal/v1/source-control"]);
  } finally {
    await Promise.all(
      [target, proxy]
        .filter((server) => server.listening)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
    );
  }
}, 15_000);
