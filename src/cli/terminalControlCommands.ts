import { createConnection } from "node:net";
import {
  TERMINAL_CONTROL_PROTOCOL_VERSION,
  type TerminalControlOperation,
  type TerminalControlRequest,
  type TerminalControlResponse,
  type TerminalNotificationSeverity,
} from "@vibestudio/shared/terminalControlProtocol";
import type { CliCommand, ParsedInvocation } from "./commandTable.js";
import { UsageError, printError } from "./output.js";

const severityNames = new Set<TerminalNotificationSeverity>([
  "info",
  "done",
  "waiting",
  "approval",
  "failure",
]);

function command(
  name: string,
  summary: string,
  usage: string,
  operation: (inv: ParsedInvocation) => TerminalControlOperation,
  flags: CliCommand["flags"] = []
): CliCommand {
  return {
    group: "terminal",
    name,
    summary,
    usage,
    flags,
    async run(inv) {
      try {
        const response = await callTerminalControl(operation(inv));
        if (!response.ok) throw new Error(response.error);
        if (response.stdout !== undefined) process.stdout.write(response.stdout);
        return 0;
      } catch (error) {
        return printError(error, { json: false });
      }
    },
  };
}

function required(value: string | boolean | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new UsageError(`${label} is required`);
  return value;
}

function one(inv: ParsedInvocation, label: string): string {
  const [value] = inv.positionals;
  if (inv.positionals.length !== 1 || value === undefined) {
    throw new UsageError(`${label} requires exactly one value`);
  }
  return value;
}

function parseValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export const terminalControlCommands: CliCommand[] = [
  command("list", "List terminal sessions owned by this panel", "vibestudio terminal list", () => ({
    kind: "list",
  })),
  command(
    "badge",
    "Set or clear this terminal's badge",
    "vibestudio terminal badge <text|clear> [--color <color>]",
    (inv) => ({
      kind: "badge",
      text: inv.positionals.join(" "),
      ...(typeof inv.flags["color"] === "string" ? { color: inv.flags["color"] } : {}),
    }),
    [{ name: "color", takesValue: true, description: "Badge color" }]
  ),
  command("label", "Rename this terminal session", "vibestudio terminal label <label>", (inv) => ({
    kind: "label",
    label: inv.positionals.join(" "),
  })),
  command(
    "meta",
    "Set, read, or delete session metadata",
    "vibestudio terminal meta <set|get|delete> <key> [json-or-text]",
    (inv) => {
      const [action, key, ...value] = inv.positionals;
      if (!key || (action !== "set" && action !== "get" && action !== "delete")) {
        throw new UsageError("meta requires set|get|delete and a key");
      }
      if (action === "set") {
        if (value.length === 0) throw new UsageError("meta set requires a value");
        return { kind: "meta-set", key, value: parseValue(value.join(" ")) };
      }
      if (value.length > 0) throw new UsageError(`meta ${action} accepts only a key`);
      return action === "get" ? { kind: "meta-get", key } : { kind: "meta-delete", key };
    }
  ),
  command(
    "notify",
    "Emit a terminal notification",
    "vibestudio terminal notify <message> [--severity <name>] [--title <text>]",
    (inv) => {
      const severity = typeof inv.flags["severity"] === "string" ? inv.flags["severity"] : "info";
      if (!severityNames.has(severity as TerminalNotificationSeverity)) {
        throw new UsageError(`invalid terminal notification severity: ${severity}`);
      }
      return {
        kind: "notify",
        severity: severity as TerminalNotificationSeverity,
        title: typeof inv.flags["title"] === "string" ? inv.flags["title"] : "",
        message: inv.positionals.join(" "),
      };
    },
    [
      {
        name: "severity",
        takesValue: true,
        description: "info, done, waiting, approval, or failure",
      },
      { name: "title", takesValue: true, description: "Notification title" },
    ]
  ),
  command(
    "send",
    "Write text to another terminal owned by this panel",
    "vibestudio terminal send --to <session-id> --text <text>",
    (inv) => ({
      kind: "send",
      targetSessionId: required(inv.flags["to"], "--to"),
      text: required(inv.flags["text"], "--text"),
    }),
    [
      { name: "to", takesValue: true, description: "Target session ID" },
      { name: "text", takesValue: true, description: "Text to write" },
    ]
  ),
  command(
    "split",
    "Split this terminal right or down",
    "vibestudio terminal split <right|down> [--command <command>]",
    (inv) => {
      const direction = one(inv, "split");
      if (direction !== "right" && direction !== "down") {
        throw new UsageError("split direction must be right or down");
      }
      return {
        kind: "split",
        direction: direction === "right" ? "row" : "column",
        ...(typeof inv.flags["command"] === "string" ? { command: inv.flags["command"] } : {}),
      };
    },
    [{ name: "command", takesValue: true, description: "Command for the new session" }]
  ),
  command("open", "Open an approved HTTP(S) URL", "vibestudio terminal open <url>", (inv) => ({
    kind: "open",
    url: one(inv, "open"),
  })),
];

export function callTerminalControl(
  operation: TerminalControlOperation,
  environment: NodeJS.ProcessEnv = process.env
): Promise<TerminalControlResponse> {
  const endpoint = environment["VIBESTUDIO_TERMINAL_ENDPOINT"];
  const hostBuildId = environment["VIBESTUDIO_HOST_BUILD_ID"];
  if (!endpoint) {
    throw new UsageError(
      "vibestudio terminal control commands are available only inside a managed terminal"
    );
  }
  if (!hostBuildId) throw new Error("managed terminal has no exact host build identity");
  const request: TerminalControlRequest = {
    protocolVersion: TERMINAL_CONTROL_PROTOCOL_VERSION,
    hostBuildId,
    pid: process.pid,
    operation,
  };
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let response = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(response || "{}") as TerminalControlResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}
