import type { RuntimeEntityHandle } from "@vibestudio/shared/runtime/entitySpec";
import { docsMethods } from "@vibestudio/service-schemas/docs";
import { runtimeMethods } from "@vibestudio/service-schemas/runtime";
import { workspaceMethods } from "@vibestudio/service-schemas/workspace";
import { JSON_FLAG, type CliCommand, type ParsedInvocation } from "../commandTable.js";
import { loadCliCredentials, saveCliCredentials, type CliCredentials } from "../credentialStore.js";
import { pairRemoteServer, selectRemoteWorkspace } from "../remoteClient.js";
import { RpcClient, RpcError } from "../rpcClient.js";
import {
  deleteAgentSession,
  isValidSessionName,
  listAgentSessions,
  loadAgentSession,
  saveAgentSession,
  type AgentSession,
} from "../sessionStore.js";
import {
  AuthError,
  CliError,
  StaleSessionError,
  UsageError,
  jsonMode,
  printError,
  printResult,
} from "../output.js";
import { typedClient } from "../typedClients.js";
import { skillCommand } from "./skillCommand.js";

/**
 * `vibestudio agent ...` — durable agent sessions backed by `session` runtime
 * entities on a paired Vibestudio server, plus generic RPC access (call,
 * services, skills, logs) scoped to the paired device credential.
 */

const DEFAULT_SESSION = "default";

function requireWorkspaceCredentials(): CliCredentials {
  const creds = loadCliCredentials();
  if (!creds) {
    throw new AuthError('not paired — run `vibestudio remote pair "<pair-link>"` first');
  }
  if (!creds.workspaceName) {
    throw new AuthError(
      "no remote workspace selected — run `vibestudio remote select <workspace>`"
    );
  }
  return creds;
}

function sessionName(inv: ParsedInvocation): string {
  const name = inv.positionals[0] ?? DEFAULT_SESSION;
  if (!isValidSessionName(name)) {
    throw new UsageError(`Invalid session name: ${name} (use letters, digits, "_", "-")`);
  }
  return name;
}

function assertSessionWorkspace(session: AgentSession, creds: CliCredentials): void {
  if (session.serverId !== creds.serverId || session.workspaceId !== creds.workspaceId) {
    throw new StaleSessionError(
      `session ${session.name} belongs to ${session.serverId}/${session.workspaceId}, ` +
        `but the selected workspace is ${creds.serverId}/${creds.workspaceId}`
    );
  }
}

/** Whether an RPC failure means the entity is already gone on the server. */
function isEntityNotFoundError(error: unknown): boolean {
  return (
    error instanceof RpcError &&
    (error.errorCode === "ENTITY_NOT_FOUND" ||
      /\b(?:not found|unknown entity|no such entity|already retired)\b/i.test(error.message))
  );
}

async function sessionEntityExists(client: RpcClient, entityId: string): Promise<boolean> {
  const runtime = typedClient("runtime", runtimeMethods, client);
  const entities = await runtime.listEntities({ kind: "session" });
  return entities.some((entity) => entity.id === entityId);
}

interface EnsuredAgentSession {
  session: AgentSession;
  reused: boolean;
}

async function ensureAgentSessionWithCredentials(
  name: string,
  creds: CliCredentials,
  client = new RpcClient(creds)
): Promise<EnsuredAgentSession> {
  if (!isValidSessionName(name)) {
    throw new UsageError(`Invalid session name: ${name} (use letters, digits, "_", "-")`);
  }
  if (!creds.workspaceName) {
    throw new AuthError(
      "no remote workspace selected — run `vibestudio remote select <workspace>`"
    );
  }
  const existing = loadAgentSession(name);
  const sameWorkspace =
    existing?.serverId === creds.serverId && existing.workspaceId === creds.workspaceId;
  if (existing && !sameWorkspace) {
    console.error(
      `warning: session ${name} belongs to ${existing.serverId}/${existing.workspaceId}; ` +
        `recreating it on ${creds.serverId}/${creds.workspaceId}`
    );
  }
  if (existing && sameWorkspace && (await sessionEntityExists(client, existing.entityId))) {
    const current =
      existing.workspaceName === creds.workspaceName
        ? existing
        : { ...existing, workspaceName: creds.workspaceName };
    if (current !== existing) saveAgentSession(current);
    return { session: current, reused: true };
  }

  const runtime = typedClient("runtime", runtimeMethods, client);
  const handle = (await runtime.createEntity({
    kind: "session",
    source: "agent-cli",
    key: name,
    title: name,
  })) as RuntimeEntityHandle;
  const session: AgentSession = {
    schemaVersion: 3,
    name,
    serverId: creds.serverId,
    workspaceId: creds.workspaceId,
    workspaceName: creds.workspaceName,
    entityId: handle.id,
    contextId: handle.contextId,
    scopeKey: name,
    createdAt: Date.now(),
  };
  saveAgentSession(session);
  return { session, reused: false };
}

/** Ensure a named session exists in the currently selected workspace.
 * System-test commands use this for explicit `--session` scopes so an
 * ephemeral dev-workspace restart repairs its context without a manual attach. */
export async function ensureNamedAgentSession(
  name: string,
  client?: RpcClient
): Promise<AgentSession> {
  return (await ensureAgentSessionWithCredentials(name, requireWorkspaceCredentials(), client))
    .session;
}

async function attach(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const isPairingLink = (value: string) =>
      value.startsWith("vibestudio://") || value.startsWith("https://vibestudio.app/pair");
    const link = inv.positionals.find(isPairingLink);
    const workspace =
      typeof inv.flags["workspace"] === "string" ? inv.flags["workspace"].trim() : "";
    const name = sessionName({
      ...inv,
      positionals: inv.positionals.filter((arg) => !isPairingLink(arg)),
    });
    let creds = loadCliCredentials();
    if (creds && link) {
      throw new UsageError(
        "already paired — run `vibestudio remote logout` to re-pair, or attach without a pairing link"
      );
    }
    if (!creds) {
      if (link) {
        creds = await pairRemoteServer({ link });
        saveCliCredentials(creds);
      } else if (process.stdin.isTTY) {
        throw new AuthError(
          "not paired — pass a vibestudio://connect pairing link to pair while attaching"
        );
      } else {
        throw new AuthError("not paired and no pairing options given");
      }
    }
    if (workspace) {
      creds = await selectRemoteWorkspace(creds, workspace);
      saveCliCredentials(creds);
    }
    if (!creds.workspaceName) {
      throw new AuthError(
        "no remote workspace selected — pass --workspace <name> or run `vibestudio remote select <workspace>`"
      );
    }
    const { session, reused } = await ensureAgentSessionWithCredentials(name, creds);
    printResult(session, {
      json,
      human: () => {
        console.log(`attached ${session.name}${reused ? " (existing)" : ""}`);
        console.log(`entity: ${session.entityId}`);
        console.log(`context: ${session.contextId}`);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function status(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const name = sessionName(inv);
    const session = loadAgentSession(name);
    if (!session) throw new CliError(`no session named ${name} — run \`vibestudio agent attach\``);
    const creds = requireWorkspaceCredentials();
    assertSessionWorkspace(session, creds);
    const client = new RpcClient(creds);
    const live = await sessionEntityExists(client, session.entityId);
    if (!live) {
      throw new StaleSessionError(
        `session ${name} is stale: entity ${session.entityId} no longer exists`
      );
    }
    printResult(
      { ...session, live },
      {
        json,
        human: () => {
          console.log(`session: ${session.name}`);
          console.log(`server: ${session.serverId}/${session.workspaceName}`);
          console.log(`entity: ${session.entityId}`);
          console.log(`context: ${session.contextId}`);
          console.log("status: live");
        },
      }
    );
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function detach(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const name = sessionName(inv);
    const session = loadAgentSession(name);
    if (!session) throw new CliError(`no session named ${name}`);
    const creds = requireWorkspaceCredentials();
    assertSessionWorkspace(session, creds);
    const client = new RpcClient(creds);
    const runtime = typedClient("runtime", runtimeMethods, client);
    let entityMissing = false;
    try {
      await runtime.retireEntity({ id: session.entityId, removeContext: inv.flags["rm"] === true });
    } catch (error) {
      // The entity is already gone — still clean up the local session file.
      if (!isEntityNotFoundError(error)) throw error;
      entityMissing = true;
    }
    deleteAgentSession(name);
    printResult(
      {
        detached: name,
        entityId: session.entityId,
        removedContext: inv.flags["rm"] === true,
        entityMissing,
      },
      {
        json,
        human: () =>
          console.log(
            entityMissing ? `detached ${name} (entity already gone)` : `detached ${name}`
          ),
      }
    );
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function sessions(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const local = listAgentSessions();
    // Unpaired: still list local session files, with unknown liveness.
    const creds = loadCliCredentials();
    let liveIds: Set<string> | null = null;
    if (creds?.workspaceName) {
      const client = new RpcClient(creds);
      const runtime = typedClient("runtime", runtimeMethods, client);
      const entities = await runtime.listEntities({ kind: "session" });
      liveIds = new Set(entities.map((entity) => entity.id));
    }
    const rows = local.map((session) => ({
      name: session.name,
      entityId: session.entityId,
      contextId: session.contextId,
      serverId: session.serverId,
      workspaceId: session.workspaceId,
      workspaceName: session.workspaceName,
      live:
        creds && liveIds
          ? session.serverId === creds.serverId &&
            session.workspaceId === creds.workspaceId &&
            liveIds.has(session.entityId)
          : null,
    }));
    printResult(rows, {
      json,
      human: () => {
        if (rows.length === 0) {
          console.log("no agent sessions");
          return;
        }
        for (const row of rows) {
          const liveness = row.live === null ? "unknown" : row.live ? "live" : "stale";
          console.log(`${row.name}  ${liveness}  ${row.entityId}`);
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function call(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const target = typeof inv.flags["target"] === "string" ? inv.flags["target"] : undefined;
    const method = inv.positionals[0];
    // Relay targets (workers/DOs/panels) dispatch plain entity-defined method
    // names; only direct server calls require the SERVICE.METHOD form.
    if (!method || (!target && !method.includes("."))) {
      throw new UsageError(
        "usage: vibestudio agent call SERVICE.METHOD [ARGS_JSON] [--target ID] (plain METHOD with --target)"
      );
    }
    let args: unknown[] = [];
    if (inv.positionals[1] !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(inv.positionals[1]);
      } catch {
        throw new UsageError("ARGS_JSON must be valid JSON");
      }
      if (!Array.isArray(parsed)) throw new UsageError("ARGS_JSON must be a JSON array");
      args = parsed;
    }
    const client = new RpcClient(requireWorkspaceCredentials());
    const result = target
      ? await client.callTarget(target, method, args)
      : await client.call(method, args);
    printResult(result, { json });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function services(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const docs = typedClient("docs", docsMethods, new RpcClient(requireWorkspaceCredentials()));
    const name = inv.positionals[0];
    if (name) {
      const def = await docs.describeService(name);
      if (!def) return printError(new Error(`Unknown service: ${name}`), { json });
      printResult(def, { json });
      return 0;
    }
    const defs = await docs.listServices();
    printResult(defs, {
      json,
      human: () => {
        for (const def of defs) {
          console.log(def.description ? `${def.name}  ${def.description}` : def.name);
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function skills(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const workspace = typedClient(
      "workspace",
      workspaceMethods,
      new RpcClient(requireWorkspaceCredentials())
    );
    const name = inv.positionals[0];
    if (name) {
      const content = await workspace.readSkill(name);
      printResult(content, { json });
      return 0;
    }
    const entries = await workspace.listSkills();
    printResult(entries, {
      json,
      human: () => {
        for (const entry of entries) {
          const prefix = `${entry.name}  ${entry.dirPath}`;
          console.log(entry.description ? `${prefix}  ${entry.description}` : prefix);
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function logs(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const unit = inv.positionals[0];
    if (!unit) {
      throw new UsageError(
        "usage: vibestudio agent logs UNIT [--since MS] [--level L] [--limit N]"
      );
    }
    const options: {
      since?: number;
      level?: "debug" | "info" | "warn" | "error";
      limit?: number;
    } = {};
    if (typeof inv.flags["since"] === "string") {
      const since = Number(inv.flags["since"]);
      if (!Number.isFinite(since)) throw new UsageError("--since must be a number (epoch ms)");
      options.since = since;
    }
    if (typeof inv.flags["level"] === "string") {
      const level = inv.flags["level"];
      if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
        throw new UsageError("--level must be one of: debug, info, warn, error");
      }
      options.level = level;
    }
    if (typeof inv.flags["limit"] === "string") {
      const limit = Number(inv.flags["limit"]);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new UsageError("--limit must be a positive integer");
      }
      options.limit = limit;
    }
    const workspace = typedClient(
      "workspace",
      workspaceMethods,
      new RpcClient(requireWorkspaceCredentials())
    );
    const records = await workspace.units.logs(unit, options);
    printResult(records, { json });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function diag(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const unit = inv.positionals[0];
    if (!unit) {
      throw new UsageError("usage: vibestudio agent diag UNIT [--since MS] [--limit N]");
    }
    const options: { since?: number; limit?: number } = {};
    if (typeof inv.flags["since"] === "string") {
      const since = Number(inv.flags["since"]);
      if (!Number.isFinite(since)) throw new UsageError("--since must be a number (epoch ms)");
      options.since = since;
    }
    if (typeof inv.flags["limit"] === "string") {
      const limit = Number(inv.flags["limit"]);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new UsageError("--limit must be a positive integer");
      }
      options.limit = limit;
    }
    const workspace = typedClient(
      "workspace",
      workspaceMethods,
      new RpcClient(requireWorkspaceCredentials())
    );
    const result = await workspace.units.diagnostics(unit, options);
    if (json) {
      printResult(result, { json });
      return 0;
    }
    const ts = (ms: number) => new Date(ms).toISOString();
    if (result.unit) {
      console.log(`${result.unit.name} (${result.unit.kind}) — status: ${result.unit.status}`);
      if (result.unit.lastError) console.log(`last error: ${result.unit.lastError}`);
    } else {
      console.log(`${unit} — unit not found in workspace (showing raw diagnostics)`);
    }
    const builds = result.builds;
    if (builds.length > 0) {
      console.log("\nrecent builds:");
      for (const event of builds.slice(-10)) {
        const suffix = event.type === "build-error" ? ` — ${event.error}` : "";
        console.log(`  ${event.timestamp}  ${event.type}${suffix}`);
      }
    }
    if (result.errors.length > 0) {
      console.log("\nrecent errors:");
      for (const entry of result.errors.slice(-20)) {
        console.log(`  ${ts(entry.timestamp)}  ${entry.message}`);
      }
    }
    if (result.logs.length > 0) {
      console.log("\nrecent logs:");
      for (const entry of result.logs.slice(-20)) {
        console.log(`  ${ts(entry.timestamp)}  [${entry.level}] ${entry.message}`);
      }
    }
    if (builds.length === 0 && result.errors.length === 0 && result.logs.length === 0) {
      console.log("no diagnostics recorded for this unit");
    }
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

export const agentCommands: CliCommand[] = [
  {
    group: "agent",
    name: "attach",
    summary: "Attach (create or reuse) a durable agent session entity",
    usage: "vibestudio agent attach [NAME] [PAIRING_LINK] [--workspace NAME]",
    flags: [
      { name: "workspace", takesValue: true, description: "Select a workspace before attaching" },
      JSON_FLAG,
    ],
    run: attach,
  },
  {
    group: "agent",
    name: "status",
    summary: "Show a session and verify its entity is still live",
    usage: "vibestudio agent status [NAME]",
    flags: [JSON_FLAG],
    run: status,
  },
  {
    group: "agent",
    name: "detach",
    summary: "Retire a session entity and delete the local session file",
    usage: "vibestudio agent detach [NAME] [--rm]",
    flags: [
      { name: "rm", takesValue: false, description: "Also remove the session's context folder" },
      JSON_FLAG,
    ],
    run: detach,
  },
  {
    group: "agent",
    name: "sessions",
    summary: "List local sessions reconciled against live entities",
    usage: "vibestudio agent sessions",
    flags: [JSON_FLAG],
    run: sessions,
  },
  {
    group: "agent",
    name: "call",
    summary: "Invoke an RPC method (optionally relayed to a runtime target)",
    usage:
      "vibestudio agent call SERVICE.METHOD [ARGS_JSON] [--target ID] (plain METHOD with --target)",
    flags: [{ name: "target", takesValue: true, description: "Relay target id" }, JSON_FLAG],
    run: call,
  },
  {
    group: "agent",
    name: "services",
    summary: "List registered RPC services, or describe one",
    usage: "vibestudio agent services [NAME]",
    flags: [JSON_FLAG],
    run: services,
  },
  {
    group: "agent",
    name: "skills",
    summary: "List workspace skills, or print one SKILL.md",
    usage: "vibestudio agent skills [NAME_OR_REPO_PATH]",
    flags: [JSON_FLAG],
    run: skills,
  },
  {
    group: "agent",
    name: "logs",
    summary: "Read workspace unit logs",
    usage: "vibestudio agent logs UNIT [--since MS] [--level L] [--limit N]",
    flags: [
      { name: "since", takesValue: true, description: "Epoch ms lower bound" },
      { name: "level", takesValue: true, description: "Minimum level (debug|info|warn|error)" },
      { name: "limit", takesValue: true, description: "Max records (<=1000)" },
      JSON_FLAG,
    ],
    run: logs,
  },
  {
    group: "agent",
    name: "diag",
    summary: "Unit health: status, last error, recent build events, error/log tail",
    usage: "vibestudio agent diag UNIT [--since MS] [--limit N]",
    flags: [
      { name: "since", takesValue: true, description: "Epoch ms lower bound" },
      { name: "limit", takesValue: true, description: "Max log records (<=1000)" },
      JSON_FLAG,
    ],
    run: diag,
  },
  skillCommand,
];
