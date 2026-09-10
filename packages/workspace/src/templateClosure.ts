import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";

/**
 * The repositories a template needs, given the ones it declares.
 *
 * A declared repository drags in whatever it depends on, so both producers of
 * a template snapshot — the distribution builder reading a checkout, and
 * publication reading a workspace's reviewed VCS state — have to compute the
 * same closure over the same two kinds of edge. They did, separately, and that
 * cost a bug twice over: excluding a dependency's repositories was implemented
 * in one and missing from the other, because nothing tied them together.
 *
 * Only the walk lives here. Resolving an edge stays with the caller, along with
 * the wording of its failures, because what it means for a package to be
 * missing differs between a checkout on disk and a workspace observation.
 */

export interface TemplateClosureInput {
  /** Repositories the template declares, all of which are included. */
  roots: readonly string[];
  /**
   * Repositories a declared dependency already supplies.
   *
   * Never admitted, however they are reached: a template built on another
   * declares only what it adds, so its closure has to stop at that edge or the
   * composed workspace ends up with two layers claiming one repository.
   */
  provided?: ReadonlySet<string>;
  /** Workspace package names this repository depends on. */
  packageDependenciesOf(repoPath: string): readonly string[];
  /** The one repository owning a package name. Throws when it cannot say. */
  ownerOfPackage(packageName: string, dependent: string): string;
  /** Further repositories this one requires for reasons of its own. */
  requiredRepositoriesOf?(repoPath: string): readonly string[];
}

export interface TemplateClosure {
  /** Every repository the template needs, declared and pulled in alike. */
  included: string[];
  /** Those pulled in rather than declared, which a review has to disclose. */
  required: string[];
}

/** Walk a template's declared repositories out to everything they require. */
export function resolveTemplateClosure(input: TemplateClosureInput): TemplateClosure {
  const provided = input.provided ?? new Set<string>();
  const included = new Set<string>();
  const required = new Set<string>();
  const pending: string[] = [];
  const admit = (repoPath: string, declared: boolean): void => {
    if (provided.has(repoPath) || included.has(repoPath)) return;
    included.add(repoPath);
    if (!declared) required.add(repoPath);
    pending.push(repoPath);
  };
  for (const root of input.roots) admit(root, true);
  while (pending.length > 0) {
    const repoPath = pending.shift()!;
    for (const dependency of input.packageDependenciesOf(repoPath)) {
      admit(input.ownerOfPackage(dependency, repoPath), false);
    }
    for (const target of input.requiredRepositoriesOf?.(repoPath) ?? []) admit(target, false);
  }
  return {
    included: [...included].sort(compareUtf16CodeUnits),
    required: [...required].sort(compareUtf16CodeUnits),
  };
}
