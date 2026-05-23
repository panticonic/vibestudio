/**
 * Resource loader — fetches the system prompt and skill index from the
 * NatStack workspace via RPC.
 *
 * PiRunner uses this at session startup to inject `AGENTS.md` content and
 * a formatted skill index into the agent's system prompt. The skill index
 * is markdown that the LLM can read; actual skill files are read on demand
 * by the read tool from the per-context folder (skills and AGENTS.md are
 * copied into each context folder at creation time).
 *
 * Contract: `workspace.getAgentsMd` returns the workspace AGENTS.md
 * as a string; `workspace.listSkills` returns an array of `SkillEntry`
 * descriptors (one per skill directory under `workspace/skills/`).
 */
import type { RpcCaller } from "@natstack/rpc";
export type { RpcCaller } from "@natstack/rpc";
export interface SkillEntry {
    /** Skill identifier; matches the directory name under `workspace/skills/`. */
    name: string;
    /** Short human-readable description shown in the skill index. */
    description: string;
    /** Absolute path to the skill directory (informational; not used by LLM). */
    dirPath: string;
}
export interface NatStackResources {
    /** Contents of `workspace/meta/AGENTS.md`. */
    systemPrompt: string;
    /** Markdown-formatted skill index suitable for appending to the system prompt. */
    skillIndex: string;
    /** Raw skill descriptors. */
    skills: SkillEntry[];
}
export interface ResourceLoaderDeps {
    rpc: RpcCaller;
    signal?: AbortSignal;
}
/**
 * Fetches the workspace system prompt and skill list in parallel and
 * returns a `NatStackResources` bundle for PiRunner to consume.
 */
export async function loadNatStackResources(deps: ResourceLoaderDeps): Promise<NatStackResources> {
    throwIfAborted(deps.signal);
    const [systemPrompt, skills] = await Promise.all([
        abortable(callWorkspace<string>(deps, "workspace.getAgentsMd"), deps.signal),
        abortable(callWorkspace<SkillEntry[]>(deps, "workspace.listSkills"), deps.signal),
    ]);
    const skillIndex = formatSkillIndex(skills);
    return { systemPrompt, skillIndex, skills };
}

function callWorkspace<T>(deps: ResourceLoaderDeps, method: string): Promise<T> {
    if (deps.signal)
        return deps.rpc.call<T>("main", method, [], { signal: deps.signal });
    return deps.rpc.call<T>("main", method, []);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted)
        return;
    throw createAbortError(signal);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal)
        return promise;
    throwIfAborted(signal);
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(createAbortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (err) => {
                signal.removeEventListener("abort", onAbort);
                reject(err);
            }
        );
    });
}

function createAbortError(signal: AbortSignal): Error {
    const reason = signal.reason;
    if (reason instanceof Error)
        return reason;
    const err = new Error(typeof reason === "string" ? reason : "Resource loading aborted");
    err.name = "AbortError";
    return err;
}
/**
 * Renders the skill index as a markdown section. Returns an empty string
 * when there are no skills (so the caller can simply concatenate it with
 * the system prompt without conditional logic).
 */
export function formatSkillIndex(skills: SkillEntry[]): string {
    if (skills.length === 0)
        return "";
    const lines: string[] = ["", "## Available skills", ""];
    for (const s of skills) {
        lines.push(`- **${s.name}** \u2014 ${s.description}`);
    }
    lines.push("");
    lines.push('Use the read tool to load a skill: `read("skills/<name>/SKILL.md")`.');
    lines.push("(Skill files are available in the per-context folder under `skills/<name>/`.)");
    return lines.join("\n");
}
