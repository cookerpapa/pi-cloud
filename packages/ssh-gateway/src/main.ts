import { createDatabase } from "@pi-cloud/database";
import { loadSshGatewayConfig } from "./config.ts";
import { createSshGateway } from "./server.ts";
import { SshTicketAuthority } from "./ticket-authority.ts";

const config = await loadSshGatewayConfig();
const database = createDatabase({ connectionString: config.databaseUrl, maxConnections: 8 });
const server = createSshGateway({
  config,
  authority: new SshTicketAuthority({ database }),
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, config.host, resolve);
});
process.stdout.write(
  `${JSON.stringify({ event: "ssh_gateway.ready", host: config.host, port: config.port })}\n`,
);

let closing: Promise<void> | undefined;
const close = (): Promise<void> => {
  closing ??= new Promise<void>((resolve) => server.close(() => resolve())).finally(() =>
    database.destroy(),
  );
  return closing;
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
