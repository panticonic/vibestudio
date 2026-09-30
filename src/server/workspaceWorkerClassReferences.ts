import type { WorkspaceDeclarations } from "@vibestudio/workspace/singletonRegistry";

/** Runtime/schema proof is scoped to the worker source and exported class,
 * not the service name, object key, or route that happens to reference it. */
export function workspaceWorkerClassReferences(
  declarations: WorkspaceDeclarations
): Map<string, Set<string>> {
  const references = new Map<string, Set<string>>();
  const add = (source: string, className: string): void => {
    let classes = references.get(source);
    if (!classes) references.set(source, (classes = new Set()));
    classes.add(className);
  };
  for (const singleton of declarations.singletons.all()) {
    add(singleton.source, singleton.className);
  }
  for (const declaration of [...declarations.services, ...declarations.routes]) {
    if (declaration.durableObject) {
      add(declaration.source, declaration.durableObject.className);
    }
  }
  return references;
}

/** Unchanged published references already have their schema proof. A new
 * source/class pair must be checked even when only workspace metadata changed. */
export function newlyReferencedWorkerSources(
  published: ReadonlyMap<string, ReadonlySet<string>>,
  candidate: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  return [...candidate]
    .filter(([source, classes]) =>
      [...classes].some((className) => !published.get(source)?.has(className))
    )
    .map(([source]) => source);
}
