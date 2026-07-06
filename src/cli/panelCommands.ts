/**
 * `vibestudio panel ...` — panel inspection for agents and scripts.
 *
 * The frontend-dev loop's eyes: enumerate the live panel tree, capture a
 * screenshot of a running panel (written to a real image file — exactly what a
 * headless agent needs to look at UI it is building), and read a panel's
 * console history. All three relay to host services (`panelTree.*` reads,
 * `panelCdp.screenshot` / `panelCdp.consoleHistory`); screenshot/console are
 * context-boundary gated server-side — a panel in the agent's own context is
 * free, a foreign-context panel is denied with remediation guidance (open a
 * preview instance in your own context instead).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  JSON_FLAG,
  type CliCommand,
  type FlagSpec,
  type ParsedInvocation,
} from "./commandTable.js";
import { jsonMode, printError, printResult, UsageError } from "./output.js";
import { resolveSessionScope, SCOPE_FLAGS } from "./agent/sessionContext.js";

interface PanelNode {
  id?: string;
  title?: string;
  kind?: string;
  source?: string;
  contextId?: string;
  children?: unknown[];
}

interface PanelRow {
  id: string;
  title: string | null;
  kind: string | null;
  source: string | null;
  contextId: string | null;
  depth: number;
}

interface PanelScreenshotResult {
  data: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

interface PanelConsoleHistoryEntry {
  timestamp: number;
  level: string;
  message: string;
  line: number;
  sourceId: string;
  url: string;
}

interface PanelConsoleHistoryResult {
  entries: PanelConsoleHistoryEntry[];
  errors: PanelConsoleHistoryEntry[];
  dropped: { entries: number; errors: number };
}

function flattenTree(nodes: unknown[], depth: number, out: PanelRow[]): void {
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as PanelNode;
    if (typeof node.id === "string") {
      out.push({
        id: node.id,
        title: typeof node.title === "string" ? node.title : null,
        kind: typeof node.kind === "string" ? node.kind : null,
        source: typeof node.source === "string" ? node.source : null,
        contextId: typeof node.contextId === "string" ? node.contextId : null,
        depth,
      });
    }
    if (Array.isArray(node.children)) flattenTree(node.children, depth + 1, out);
  }
}

async function list(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const { client, contextId } = resolveSessionScope(inv);
    const snapshot = await client.call<{ roots?: unknown[] }>("panelTree.getTreeSnapshot", []);
    const rows: PanelRow[] = [];
    flattenTree(snapshot.roots ?? [], 0, rows);
    printResult(rows, {
      json,
      human: () => {
        if (rows.length === 0) {
          console.log("no panels");
          return;
        }
        for (const row of rows) {
          const here = row.contextId === contextId ? " *" : "";
          const indent = "  ".repeat(row.depth);
          const label = row.title ?? row.source ?? row.kind ?? "?";
          console.log(
            `${indent}${row.id}${here}\t${label}\tsource=${row.source ?? "?"}\tcontext=${row.contextId ?? "?"}`
          );
        }
        console.log("\n(* = your context; agents can only screenshot their own context's panels)");
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function screenshot(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const panelId = requirePanelId(inv);
    const format = inv.flags["format"] === "jpeg" ? "jpeg" : "png";
    const quality = intFlag(inv, "quality");
    const { client } = resolveSessionScope(inv);
    const result = await client.call<PanelScreenshotResult>("panelCdp.screenshot", [
      panelId,
      { format, ...(quality !== undefined ? { quality } : {}) },
    ]);
    const outFlag = inv.flags["out"];
    const ext = result.mimeType === "image/jpeg" ? "jpg" : "png";
    const outPath = path.resolve(
      typeof outFlag === "string" && outFlag
        ? outFlag
        : `panel-${sanitize(panelId)}-${Date.now()}.${ext}`
    );
    fs.writeFileSync(outPath, Buffer.from(result.data, "base64"));
    printResult(
      { path: outPath, mimeType: result.mimeType, width: result.width, height: result.height },
      {
        json,
        human: () => console.log(`${outPath} (${result.width}x${result.height})`),
      }
    );
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function consoleHistory(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const panelId = requirePanelId(inv);
    const limit = intFlag(inv, "limit");
    const errorsOnly = inv.flags["errors"] === true;
    const { client } = resolveSessionScope(inv);
    const result = await client.call<PanelConsoleHistoryResult>("panelCdp.consoleHistory", [
      panelId,
      { ...(limit !== undefined ? { limit, errorLimit: limit } : {}) },
    ]);
    const entries = errorsOnly ? result.errors : result.entries;
    printResult(errorsOnly ? { errors: result.errors, dropped: result.dropped } : result, {
      json,
      human: () => {
        if (entries.length === 0) {
          console.log(errorsOnly ? "no errors" : "no console output");
          return;
        }
        for (const entry of entries) {
          const when = new Date(entry.timestamp).toISOString();
          const where = entry.url ? ` (${entry.url}:${entry.line})` : "";
          console.log(`${when}\t[${entry.level}]\t${entry.message}${where}`);
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

function requirePanelId(inv: ParsedInvocation): string {
  const id = inv.positionals[0];
  if (!id) throw new UsageError("missing panel id — run `vibestudio panel list` to find one");
  return id;
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60);
}

function intFlag(inv: ParsedInvocation, name: string): number | undefined {
  const raw = inv.flags[name];
  if (typeof raw !== "string") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`--${name} must be a non-negative integer`);
  }
  return value;
}

const OUT_FLAG: FlagSpec = {
  name: "out",
  takesValue: true,
  description: "Output file path (default: ./panel-<id>-<ts>.png)",
};
const FORMAT_FLAG: FlagSpec = {
  name: "format",
  takesValue: true,
  description: "Image format: png (default) or jpeg",
};
const QUALITY_FLAG: FlagSpec = {
  name: "quality",
  takesValue: true,
  description: "JPEG quality 0-100 (default 80; ignored for png)",
};
const LIMIT_FLAG: FlagSpec = {
  name: "limit",
  takesValue: true,
  description: "Cap the number of entries",
};
const ERRORS_FLAG: FlagSpec = {
  name: "errors",
  takesValue: false,
  description: "Show only the error ring buffer",
};

export const panelCommands: CliCommand[] = [
  {
    group: "panel",
    name: "list",
    summary: "List the live panel tree (ids, sources, contexts)",
    usage: "vibestudio panel list",
    flags: [...SCOPE_FLAGS, JSON_FLAG],
    run: list,
  },
  {
    group: "panel",
    name: "screenshot",
    summary: "Capture a running panel to an image file (force-paints hidden panels)",
    usage:
      "vibestudio panel screenshot <panelId> [--out shot.png] [--format png|jpeg] [--quality N]",
    flags: [OUT_FLAG, FORMAT_FLAG, QUALITY_FLAG, ...SCOPE_FLAGS, JSON_FLAG],
    run: screenshot,
  },
  {
    group: "panel",
    name: "console",
    summary: "Read a running panel's console history (or just its errors)",
    usage: "vibestudio panel console <panelId> [--errors] [--limit N]",
    flags: [ERRORS_FLAG, LIMIT_FLAG, ...SCOPE_FLAGS, JSON_FLAG],
    run: consoleHistory,
  },
];
