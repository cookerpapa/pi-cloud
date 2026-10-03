import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSshGateway } from "../src/server.ts";
import {
  parseDevelopmentEnvironmentTerminalOpenRequest,
  parseWorkspaceTerminalClientFrame,
} from "@pi-cloud/protocol";

const servers: ReturnType<typeof createSshGateway>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("SSH gateway", () => {
  it.each([80, 600, 1000])(
    "accepts one authorized SSH shell at %i columns and bridges its PTY stream",
    async (cols) => {
      const hostKey = generateKeyPairSync("rsa", {
        modulusLength: 2_048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey;
      const inputReceived = Promise.withResolvers<void>();
      const resized = Promise.withResolvers<void>();
      const input = vi.fn(async () => {
        inputReceived.resolve();
      });
      const authority = {
        consume: vi.fn(async (username: string, password: string) =>
          username === "picloud" && password === "one-time"
            ? {
                ticketId: "10000000-0000-4000-8000-000000000001",
                tenantId: "10000000-0000-4000-8000-000000000002",
                userId: "10000000-0000-4000-8000-000000000003",
                sessionId: "10000000-0000-4000-8000-000000000004",
                environmentId: "10000000-0000-4000-8000-000000000005",
                sandboxDomainId: "sandbox-domain-test",
                sandboxControlBaseUrl: "http://sandbox-control:4300",
              }
            : undefined,
        ),
      };
      const server = createSshGateway({
        config: {
          databaseUrl: "postgresql://unused",
          terminalToken: "t".repeat(64),
          hostKey: Buffer.from(hostKey),
          host: "127.0.0.1",
          port: 0,
          allowInsecureInternalHttp: true,
        },
        authority: authority as never,
        openTerminal: async (options) => {
          parseDevelopmentEnvironmentTerminalOpenRequest({
            developmentEnvironmentProtocolVersion: 1,
            type: "development_environment_terminal.open",
            requestId: crypto.randomUUID(),
            environmentId: options.grant.environmentId,
            tenantId: options.grant.tenantId,
            userId: options.grant.userId,
            rows: options.rows,
            cols: options.cols,
          });
          expect(options.cols).toBe(cols);
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          return {
            output: {
              async *[Symbol.asyncIterator]() {
                yield Buffer.from("PI_CLOUD_SSH_READY\r\n");
                // Complete the fake process only after its command arrives;
                // a wall-clock delay can close SSH before a slow socket delivers it.
                await inputReceived.promise;
                await resized.promise;
                yield Buffer.from("PI_CLOUD_SSH_OK\r\n");
              },
            },
            input,
            async resize(rows, width) {
              parseWorkspaceTerminalClientFrame({
                workspaceTerminalProtocolVersion: 1,
                type: "workspace_terminal.resize",
                rows,
                cols: width,
              });
              expect(width).toBe(cols);
              resized.resolve();
            },
            async close() {},
          };
        },
      });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("SSH listener unavailable");
      const client = new ssh2.Client();
      const output = await new Promise<string>((resolve, reject) => {
        client.once("error", reject);
        client.once("ready", () => {
          client.shell({ rows: 24, cols }, (error, channel) => {
            if (error) {
              reject(error);
              return;
            }
            let text = "";
            channel.on("data", (chunk: Buffer) => {
              text += chunk.toString("utf8");
              if (text.includes("PI_CLOUD_SSH_READY")) channel.setWindow(26, cols, 0, 0);
            });
            channel.on("close", () => {
              client.end();
              resolve(text);
            });
            channel.write("pwd\n");
          });
        });
        client.connect({
          host: "127.0.0.1",
          port: address.port,
          username: "picloud",
          password: "one-time",
          readyTimeout: 5_000,
          hostVerifier: () => true,
        });
      });
      expect(output).toContain("PI_CLOUD_SSH_OK");
      expect(authority.consume).toHaveBeenCalledWith("picloud", "one-time");
      expect(input).toHaveBeenCalledWith(Buffer.from("pwd\n"));
    },
  );
});
