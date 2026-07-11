import * as fs from "node:fs";
import * as path from "node:path";
import { cliConfigRoot } from "./configPaths.js";

/**
 * Local record of an agent CLI session: a durable `session` runtime entity
 * on a Vibestudio server plus the context it owns. Stored one file per
 * session under the same config dir as the CLI device credential.
 */
export interface AgentSession {
  schemaVersion: 1;
  name: string;
  serverUrl: string;
  entityId: string;
  contextId: string;
  scopeKey: string;
  createdAt: number;
}

const SESSION_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_PATTERN.test(name);
}

/** Same config-dir resolution as credentialStore.ts. */
export function sessionDir(): string {
  return path.join(cliConfigRoot(), "agent-sessions");
}

export function sessionPath(name: string): string {
  if (!isValidSessionName(name)) throw new Error(`Invalid session name: ${name}`);
  return path.join(sessionDir(), `${name}.json`);
}

export function loadAgentSession(name: string): AgentSession | null {
  const p = sessionPath(name);
  if (!fs.existsSync(p)) return null;
  let parsed: Partial<AgentSession>;
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<AgentSession>;
  } catch (error) {
    console.warn(
      `[vibestudio] Could not read agent session ${p}: ${
        error instanceof Error ? error.message : String(error)
      }. Restore or remove this file before re-attaching the session.`
    );
    return null;
  }
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.name !== "string" ||
    typeof parsed.serverUrl !== "string" ||
    typeof parsed.entityId !== "string" ||
    typeof parsed.contextId !== "string" ||
    typeof parsed.scopeKey !== "string" ||
    typeof parsed.createdAt !== "number"
  ) {
    console.warn(
      `[vibestudio] Agent session file ${p} has an invalid schema. Restore or remove it before re-attaching the session.`
    );
    return null;
  }
  return parsed as AgentSession;
}

export function saveAgentSession(session: AgentSession): void {
  const p = sessionPath(session.name);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

export function deleteAgentSession(name: string): void {
  const p = sessionPath(name);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/** All locally stored sessions, sorted by name. */
export function listAgentSessions(): AgentSession[] {
  const dir = sessionDir();
  if (!fs.existsSync(dir)) return [];
  const sessions: AgentSession[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    if (!isValidSessionName(name)) continue;
    const session = loadAgentSession(name);
    if (session) sessions.push(session);
  }
  return sessions.sort((a, b) => a.name.localeCompare(b.name));
}
