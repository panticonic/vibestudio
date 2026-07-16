import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONTEXT_BINDING_FILE,
  parseContextBinding,
  type ContextBinding,
} from "@vibestudio/shared/contextBinding";

export { CONTEXT_BINDING_FILE, type ContextBinding };

export interface ContextBindingLocation {
  binding: ContextBinding;
  /** Local directory whose binding was discovered. This is the only valid cwd
   * for host-local tools; remote servers never supply a replacement path. */
  directory: string;
  filePath: string;
}

/** Find the nearest exact context binding. Invalid files fail loudly. */
export function findContextBindingLocation(
  start: string = process.cwd()
): ContextBindingLocation | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, CONTEXT_BINDING_FILE);
    if (fs.existsSync(candidate)) {
      let value: unknown;
      try {
        value = JSON.parse(fs.readFileSync(candidate, "utf8"));
      } catch (error) {
        throw new Error(
          `invalid context binding at ${candidate}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      try {
        return { binding: parseContextBinding(value), directory: dir, filePath: candidate };
      } catch (error) {
        throw new Error(
          `invalid context binding at ${candidate}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function findContextBinding(start: string = process.cwd()): ContextBinding | null {
  return findContextBindingLocation(start)?.binding ?? null;
}

export function assertBindingWorkspace(
  binding: ContextBinding,
  credential: { workspaceId: string }
): void {
  if (binding.workspaceId !== credential.workspaceId) {
    throw new Error(
      `context ${binding.contextId} belongs to workspace ${binding.workspaceId}, ` +
        `but the paired credential selects ${credential.workspaceId}`
    );
  }
}
