import * as fs from "node:fs";
import * as path from "node:path";
import type {
  TerminalClientHost,
  TerminalClientState,
  TerminalClipboard,
  TerminalNotifier,
} from "@vibestudio/shell-core/terminal/terminalClientHost";
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";
import { writeFileAtomicSync } from "../../src/atomicFile.js";
import { cliConfigRoot } from "../../src/cli/configPaths.js";
import { createTerminalFiles } from "./terminalFiles.js";
import type { RpcClient } from "@vibestudio/rpc";

/** OSC 52 payloads past this size are refused by common terminals; fail instead of truncating. */
const MAX_CLIPBOARD_BYTES = 100_000;
const MAX_STATE_BYTES = 64 * 1024;

/** `OSC 52`: put text on the person's clipboard through their terminal. */
export function createClipboard(stdout: Pick<NodeJS.WriteStream, "write">): TerminalClipboard {
  return {
    write(text) {
      const bytes = Buffer.from(text, "utf8");
      if (bytes.byteLength > MAX_CLIPBOARD_BYTES) {
        throw new Error(
          `That is too much text for the terminal clipboard (${bytes.byteLength} bytes; the limit is ${MAX_CLIPBOARD_BYTES}).`
        );
      }
      stdout.write(`\x1b]52;c;${bytes.toString("base64")}\x07`);
    },
  };
}

export type NotificationProtocol = "osc9" | "osc777" | "osc99" | "bell";

/**
 * The desktop-notification escape the person's terminal understands, from what
 * it says about itself. A multiplexer swallows these escapes, so inside one (and
 * in any terminal not recognized) the bell is all that is reliable.
 */
export function detectNotificationProtocol(env: NodeJS.ProcessEnv): NotificationProtocol {
  if (env["TMUX"] || env["STY"]) return "bell";
  const program = env["TERM_PROGRAM"];
  const term = env["TERM"] ?? "";
  if (env["KITTY_WINDOW_ID"] || term === "xterm-kitty") return "osc99";
  if (program === "iTerm.app") return "osc9";
  if (program === "WezTerm" || program === "ghostty" || term.startsWith("foot")) return "osc777";
  if (term === "xterm-ghostty") return "osc777";
  return "bell";
}

/** Notification text is shown by the terminal emulator: no control characters, no field separators. */
function plain(text: string): string {
  const printable = Array.from(text, (character) => {
    const code = character.codePointAt(0)!;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || character === ";" ? " " : character;
  }).join("");
  return printable.replace(/\s+/gu, " ").trim();
}

export function createNotifier(
  stdout: Pick<NodeJS.WriteStream, "write">,
  protocol: NotificationProtocol
): TerminalNotifier {
  return {
    notify({ title, body }) {
      const head = plain(title);
      const text = body ? plain(body) : "";
      switch (protocol) {
        case "osc9":
          stdout.write(`\x1b]9;${text ? `${head}: ${text}` : head}\x07`);
          return;
        case "osc777":
          stdout.write(`\x1b]777;notify;${head};${text}\x07`);
          return;
        case "osc99":
          stdout.write(
            `\x1b]99;i=1:d=0:p=title;${head}\x1b\\` + `\x1b]99;i=1:d=1:p=body;${text || head}\x1b\\`
          );
          return;
        case "bell":
          stdout.write("\x07");
          return;
      }
    },
  };
}

/** `<config root>/terminal-clients/<id>/state.json`, 0600, replaced atomically. */
export function clientStatePath(clientId: string, root = cliConfigRoot()): string {
  return path.join(root, "terminal-clients", clientId, "state.json");
}

export function createClientState(clientId: string, root = cliConfigRoot()): TerminalClientState {
  const file = clientStatePath(clientId, root);
  return {
    async get() {
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) throw new Error(`Client state ${file} is not a JSON object`);
      return parsed;
    },
    async set(settings) {
      if (!isRecord(settings)) throw new Error("Client state must be a JSON object");
      const text = JSON.stringify(settings);
      if (Buffer.byteLength(text) > MAX_STATE_BYTES) {
        throw new Error(`Client state is limited to ${MAX_STATE_BYTES} bytes.`);
      }
      writeFileAtomicSync(file, text, { mode: 0o600 });
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The capability-gated modules of the host ABI: a module exists only when its capability was granted. */
export function createGatedModules(input: {
  granted: readonly ClientCapability[];
  stdout: NodeJS.WriteStream;
  workspaceRpc: Pick<RpcClient, "call">;
  lifetime: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): Pick<TerminalClientHost, "files" | "clipboard" | "notify"> {
  const has = (capability: ClientCapability) => input.granted.includes(capability);
  return {
    ...(has("local-files")
      ? { files: createTerminalFiles(input.workspaceRpc, input.lifetime) }
      : {}),
    ...(has("clipboard") ? { clipboard: createClipboard(input.stdout) } : {}),
    ...(has("notifications")
      ? {
          notify: createNotifier(
            input.stdout,
            detectNotificationProtocol(input.env ?? process.env)
          ),
        }
      : {}),
  };
}
