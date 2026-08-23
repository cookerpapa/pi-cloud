import ssh2, { type ServerChannel, type Session, type Connection, type Server } from "ssh2";
import type { SshGatewayConfig } from "./config.ts";
import { SshTicketAuthority, type SshTerminalGrant } from "./ticket-authority.ts";
import { openToolBrokerTerminal } from "./tool-broker-terminal.ts";

function boundedDimension(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 2 && value <= maximum
    ? value
    : fallback;
}

export function createSshGateway(options: {
  config: SshGatewayConfig;
  authority: SshTicketAuthority;
  openTerminal?: typeof openToolBrokerTerminal;
}): Server {
  const openTerminal = options.openTerminal ?? openToolBrokerTerminal;
  return new ssh2.Server({ hostKeys: [options.config.hostKey] }, (client: Connection) => {
    let grant: SshTerminalGrant | undefined;
    client.on("authentication", (context) => {
      if (context.method !== "password") {
        context.reject(["password"]);
        return;
      }
      void options.authority.consume(context.username, context.password).then(
        (resolved) => {
          if (resolved === undefined) context.reject(["password"]);
          else {
            grant = resolved;
            context.accept();
          }
        },
        () => context.reject(["password"]),
      );
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session: Session = accept();
        let rows = 24;
        let cols = 100;
        let terminal: Awaited<ReturnType<typeof openToolBrokerTerminal>> | undefined;
        session.on("pty", (acceptPty, _reject, info) => {
          rows = boundedDimension(info.rows, 24, 500);
          cols = boundedDimension(info.cols, 100, 1_000);
          acceptPty?.();
        });
        session.on("window-change", (acceptWindow, _reject, info) => {
          rows = boundedDimension(info.rows, rows, 500);
          cols = boundedDimension(info.cols, cols, 1_000);
          void terminal?.resize(rows, cols).catch(() => undefined);
          acceptWindow?.();
        });
        session.on("shell", (acceptShell, rejectShell) => {
          if (grant === undefined || terminal !== undefined) {
            rejectShell();
            return;
          }
          const channel: ServerChannel = acceptShell();
          let channelClosed = false;
          channel.pause();
          channel.once("close", () => {
            channelClosed = true;
            void terminal?.close();
          });
          void openTerminal({
            grant,
            terminalToken: options.config.terminalToken,
            rows,
            cols,
            allowInsecureInternalHttp: options.config.allowInsecureInternalHttp,
          }).then(
            async (opened) => {
              terminal = opened;
              if (channelClosed) {
                await opened.close();
                return;
              }
              channel.on(
                "data",
                (data: Buffer) => void opened.input(data).catch(() => channel.close()),
              );
              channel.resume();
              try {
                for await (const chunk of opened.output) {
                  if (!channel.write(Buffer.from(chunk))) {
                    await new Promise<void>((resolve) => channel.once("drain", resolve));
                  }
                }
                channel.exit(0);
                channel.end();
              } catch {
                channel.stderr.write("PiCloud SSH terminal disconnected.\r\n");
                channel.exit(1);
                channel.end();
              }
            },
            () => {
              channel.stderr.write("PiCloud SSH terminal is unavailable.\r\n");
              channel.exit(1);
              channel.end();
            },
          );
        });
      });
    });
  });
}
