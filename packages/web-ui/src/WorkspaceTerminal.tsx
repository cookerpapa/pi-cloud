import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  parseWorkspaceTerminalServerFrame,
  type WorkspaceTerminalClientFrame,
} from "@pi-cloud/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n.tsx";

type TerminalState = "disconnected" | "connecting" | "ready" | "failed";

function socketUrl(target: { sessionId?: string | null; environmentId?: string | null }): string {
  const path =
    target.environmentId === undefined || target.environmentId === null
      ? `/v1/conversations/${encodeURIComponent(target.sessionId!)}/terminal`
      : `/v1/development-environments/${encodeURIComponent(target.environmentId)}/terminal`;
  const value = new URL(path, window.location.href);
  value.protocol = value.protocol === "https:" ? "wss:" : "ws:";
  return value.toString();
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function bytes(value: string): Uint8Array {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

export function WorkspaceTerminal({
  sessionId,
  environmentId,
  onError,
}: {
  sessionId?: string | null;
  environmentId?: string | null;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<TerminalState>("disconnected");
  const onErrorRef = useRef(onError);
  const tRef = useRef(t);
  const [state, setStateValue] = useState<TerminalState>("disconnected");

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const setState = useCallback((next: TerminalState): void => {
    stateRef.current = next;
    setStateValue(next);
  }, []);

  const transmit = useCallback((frame: WorkspaceTerminalClientFrame): void => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }, []);

  const disconnect = useCallback((): void => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          workspaceTerminalProtocolVersion: 1,
          type: "workspace_terminal.close",
        } satisfies WorkspaceTerminalClientFrame),
      );
      socket.close(1_000, "user closed terminal");
    } else if (socket !== null && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }
    setState("disconnected");
  }, [setState]);

  const connect = useCallback((): void => {
    if (
      (sessionId === null || sessionId === undefined) &&
      (environmentId === null || environmentId === undefined)
    ) {
      return;
    }
    if (stateRef.current === "connecting" || stateRef.current === "ready") {
      return;
    }
    const terminal = terminalRef.current;
    if (terminal === null) return;
    terminal.reset();
    terminal.writeln(`\x1b[38;5;245m${tRef.current("terminal.starting")}\x1b[0m`);
    setState("connecting");
    const socket = new WebSocket(
      socketUrl({
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(environmentId === undefined ? {} : { environmentId }),
      }),
    );
    socketRef.current = socket;
    socket.addEventListener("message", (event) => {
      try {
        const frame = parseWorkspaceTerminalServerFrame(JSON.parse(String(event.data)) as unknown);
        if (frame.type === "workspace_terminal.ready") {
          setState("ready");
          terminal.reset();
          terminal.focus();
          fitRef.current?.fit();
          transmit({
            workspaceTerminalProtocolVersion: 1,
            type: "workspace_terminal.resize",
            rows: terminal.rows,
            cols: terminal.cols,
          });
        } else if (frame.type === "workspace_terminal.output") {
          terminal.write(bytes(frame.data));
        } else if (frame.type === "workspace_terminal.exit") {
          terminal.writeln(`\r\n\x1b[38;5;245m${tRef.current("terminal.disconnected")}\x1b[0m`);
          setState("disconnected");
        } else if (frame.type === "workspace_terminal.error") {
          terminal.writeln(`\r\n\x1b[31m${frame.message}\x1b[0m`);
          setState("failed");
          onErrorRef.current(frame.message);
        }
      } catch {
        terminal.writeln(`\r\n\x1b[31m${tRef.current("terminal.invalidData")}\x1b[0m`);
        setState("failed");
      }
    });
    socket.addEventListener("close", () => {
      if (socketRef.current === socket) socketRef.current = null;
      if (stateRef.current === "ready" || stateRef.current === "connecting") {
        terminal.writeln(`\r\n\x1b[38;5;245m${tRef.current("terminal.closed")}\x1b[0m`);
        setState("disconnected");
      }
    });
    socket.addEventListener("error", () => {
      terminal.writeln(`\r\n\x1b[31m${tRef.current("terminal.connectionFailed")}\x1b[0m`);
      setState("failed");
    });
  }, [environmentId, sessionId, setState, transmit]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let terminal: Terminal;
    let fit: FitAddon;
    try {
      terminal = new Terminal({
        cursorBlink: true,
        fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.25,
        scrollback: 5_000,
        theme: {
          background: "#171917",
          foreground: "#e7e9e5",
          cursor: "#f4f1e8",
          selectionBackground: "#454b45",
        },
      });
      fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      fit.fit();
    } catch (error: unknown) {
      setState("failed");
      onErrorRef.current(
        error instanceof Error && error.message
          ? tRef.current("terminal.initializationFailed", { message: error.message })
          : tRef.current("terminal.initializationFailedGeneric"),
      );
      return;
    }
    terminal.writeln(`\x1b[38;5;245m${tRef.current("terminal.connectHint")}\x1b[0m`);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const input = terminal.onData((data) => {
      if (stateRef.current !== "ready") return;
      transmit({
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.input",
        data: base64(new TextEncoder().encode(data)),
      });
    });
    const resizeTerminal = (): void => {
      requestAnimationFrame(() => {
        if (terminalRef.current !== terminal) return;
        try {
          fit.fit();
        } catch {
          return;
        }
        if (stateRef.current === "ready") {
          transmit({
            workspaceTerminalProtocolVersion: 1,
            type: "workspace_terminal.resize",
            rows: terminal.rows,
            cols: terminal.cols,
          });
        }
      });
    };
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resizeTerminal);
    if (resize === null) window.addEventListener("resize", resizeTerminal);
    else resize.observe(host);
    return () => {
      disconnect();
      if (resize === null) window.removeEventListener("resize", resizeTerminal);
      else resize.disconnect();
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [disconnect, transmit]);

  useEffect(() => disconnect, [disconnect, environmentId, sessionId]);

  return (
    <section className="workspace-terminal-panel" aria-label={t("terminal.label")}>
      <div className="workspace-terminal-toolbar">
        <div>
          <strong>{t("terminal.title")}</strong>
          <small>
            {state === "ready"
              ? t("terminal.connected")
              : state === "connecting"
                ? t("terminal.startingCube")
                : t("terminal.notConnected")}
          </small>
        </div>
        {state === "ready" || state === "connecting" ? (
          <button onClick={disconnect} type="button">
            {t("terminal.disconnect")}
          </button>
        ) : (
          <button
            disabled={
              (sessionId === null || sessionId === undefined) &&
              (environmentId === null || environmentId === undefined)
            }
            onClick={connect}
            type="button"
          >
            {state === "failed" ? t("terminal.reconnect") : t("terminal.connect")}
          </button>
        )}
      </div>
      <p className="workspace-terminal-notice">
        {environmentId === null || environmentId === undefined
          ? t("terminal.elasticBoundary")
          : t("terminal.exclusiveBoundary")}
      </p>
      <div className="workspace-terminal-host" ref={hostRef} />
    </section>
  );
}
