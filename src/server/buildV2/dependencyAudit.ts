/**
 * Dependency-ownership rules, stated once.
 *
 * A build refuses a unit whose closure asks for something nobody owns. That
 * refusal is correct but late: it arrives when the unit is built, which for an
 * app can mean on a device, far from the manifest that caused it. The same
 * question is answerable from the graph alone, so the rules and their wording
 * live here and both callers use them -- the builder when it refuses a build,
 * and `check:userland-dependencies` when it sweeps the whole workspace.
 */

import {
  collectExternalDependencyClosure,
  type ExternalDependencyClosure,
} from "./externalDeps.js";
import type { GraphNode, PackageGraph } from "./packageGraph.js";

/**
 * How a unit is loaded, which decides who satisfies its closure's peers.
 *
 * A runtime root is loaded on its own, so nothing exists above it to provide
 * anything. A library is always loaded into a realm that already holds its
 * peers. Packages and skills are libraries; everything else that builds is a
 * runtime root; templates are content, not an artifact.
 */
export type UnitComposition = "runtime-root" | "library";

/**
 * The part of a resolved closure the ownership rules read. A prepared build
 * environment carries the same fields, so the builder asks the same questions
 * of the environment it already has.
 */
export type PeerOwnershipView = Pick<
  ExternalDependencyClosure,
  "providedPeers" | "optionalProvidedPeers" | "peerOwners" | "peerConflicts"
>;

export function compositionForKind(kind: GraphNode["kind"]): UnitComposition | null {
  if (kind === "template") return null;
  return kind === "package" ? "library" : "runtime-root";
}

/**
 * A peer resolved to a version one of its declarers does not accept. Applies to
 * every unit: a library's realm cannot fix a disagreement inside the closure.
 */
export function peerConflictRefusal(unitName: string, closure: PeerOwnershipView): string | null {
  if (closure.peerConflicts.length === 0) return null;
  return `${unitName} resolves a dependency its own closure rejects: ${closure.peerConflicts.join("; ")}.`;
}

/**
 * Peers a runtime root must adopt. Optional peers are exempt: a consumer that
 * never reaches the part needing them never needs an instance.
 */
export function unownedPeerRefusal(unitName: string, closure: PeerOwnershipView): string | null {
  const unowned = Object.entries(closure.providedPeers).filter(
    ([name]) => !closure.optionalProvidedPeers.includes(name)
  );
  if (unowned.length === 0) return null;
  const unmet = unowned
    .map(([name, range]) => {
      const owners = closure.peerOwners[name] ?? [];
      return `${name}@${range}${owners.length > 0 ? ` (required by ${owners.join(", ")})` : ""}`;
    })
    .sort();
  return (
    `${unitName} is loaded on its own, so nothing provides its closure's peers: ${unmet.join("; ")}. ` +
    `Declare each as a dependency of ${unitName} at the version it should own.`
  );
}

export interface DependencyFinding {
  unitPath: string;
  unitName: string;
  message: string;
}

/**
 * Every ownership refusal the workspace would produce, without building it.
 *
 * `appNodeModules` is not optional in practice: half of an app's closure
 * arrives through `workspace:*` dependencies on host packages, and a sweep
 * that omits it silently reports a clean workspace while the build refuses.
 */
export function auditWorkspaceDependencies(
  graph: PackageGraph,
  workspaceRoot: string,
  appNodeModules: readonly string[]
): DependencyFinding[] {
  const findings: DependencyFinding[] = [];
  const units = [...graph.allNodes()].sort((left, right) => left.name.localeCompare(right.name));

  for (const unit of units) {
    const composition = compositionForKind(unit.kind);
    if (!composition) continue;

    let closure: ExternalDependencyClosure;
    try {
      closure = collectExternalDependencyClosure(unit, graph, workspaceRoot, [...appNodeModules]);
    } catch (error) {
      findings.push({
        unitPath: unit.relativePath,
        unitName: unit.name,
        message: `closure could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    for (const message of [
      peerConflictRefusal(unit.name, closure),
      composition === "runtime-root" ? unownedPeerRefusal(unit.name, closure) : null,
    ]) {
      if (message) {
        findings.push({ unitPath: unit.relativePath, unitName: unit.name, message });
      }
    }
  }

  return findings;
}
