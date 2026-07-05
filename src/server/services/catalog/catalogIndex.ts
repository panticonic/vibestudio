/**
 * In-memory capability-catalog index behind the `docs` service.
 *
 * Builds the catalog from live sources on each operation, then serves
 * caller-filtered search/describe/getSchema. Search is a lightweight
 * token-overlap rank — adequate for the few-hundred-row catalog and
 * dependency-free. This is the swap-in point for a dedicated indexed backend
 * later (same interface), if the catalog grows enough to need it.
 *
 * Filtering reuses `isCatalogEntryVisible` so discovery never advertises what
 * the caller cannot invoke (mirrors the dispatcher's static gate).
 */
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import type { RuntimeSurface } from "@vibestudio/shared/runtimeSurface";
import type {
  CatalogEntry,
  CatalogHit,
  CatalogSurface,
} from "@vibestudio/shared/serviceSchemas/docs";
import { buildCatalog, isCatalogEntryVisible, type BuildCatalogDeps } from "./buildCatalog.js";

export interface CatalogSearchOpts {
  surface?: CatalogSurface;
  limit?: number;
}

export interface CatalogIndex {
  search(query: string, callerKind: CallerKind, opts?: CatalogSearchOpts): CatalogHit[];
  get(id: string, callerKind: CallerKind): CatalogEntry | null;
  listSurfaces(callerKind: CallerKind): Array<{ surface: CatalogSurface; count: number }>;
}

let nextSourceId = 1;
const sourceIds = new WeakMap<object, number>();
function sourceId(value: object): number {
  let id = sourceIds.get(value);
  if (id === undefined) {
    id = nextSourceId++;
    sourceIds.set(value, id);
  }
  return id;
}

type CatalogServiceDefinition = BuildCatalogDeps["definitions"][number];

function serviceSourceKey(def: CatalogServiceDefinition): string {
  const methods = Object.entries(def.methods)
    .map(([name, method]) =>
      [
        name,
        sourceId(method),
        sourceId(method.args),
        method.returns ? sourceId(method.returns) : "",
        method.policy?.allowed.join(",") ?? "",
        method.access?.sensitivity ?? "",
        method.description ?? "",
      ].join(":")
    )
    .sort()
    .join("|");
  return [
    def.name,
    sourceId(def),
    def.policy.allowed.join(","),
    def.description ?? "",
    methods,
  ].join(":");
}

function runtimeSurfaceSourceKey(surface: RuntimeSurface): string {
  const exports = Object.entries(surface.exports)
    .map(([name, entry]) =>
      [
        name,
        sourceId(entry),
        entry.kind,
        entry.description ?? "",
        entry.schemaRef ?? "",
        (entry.members ?? []).join(","),
      ].join(":")
    )
    .sort()
    .join("|");
  return [surface.target, sourceId(surface), surface.description, exports].join(":");
}

function sourceKey(deps: BuildCatalogDeps): string {
  const services = deps.definitions.map(serviceSourceKey).join("\\u001f");
  const surfaces = Object.values(deps.runtimeSurfaces ?? {})
    .filter((s): s is RuntimeSurface => Boolean(s))
    .map(runtimeSurfaceSourceKey)
    .sort()
    .join("\\u001f");
  return `${services}\\u001e${surfaces}`;
}

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1)
    )
  );
}

/** Token-overlap relevance: weight identifier/title hits above prose. */
function score(entry: CatalogEntry, terms: string[]): number {
  if (terms.length === 0) return 1; // empty query → list (rank stable)
  const name = `${entry.qualifiedName} ${entry.title}`.toLowerCase();
  const body = `${entry.description ?? ""} ${(entry.members ?? []).join(" ")}`.toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (name.includes(t)) s += 3;
    if (body.includes(t)) s += 1;
  }
  return s;
}

export function createCatalogIndex(load: () => BuildCatalogDeps): CatalogIndex {
  // Memoize the built catalog, keyed by source object identity. In practice the
  // sources are fixed after startup, so this builds once; if a service is
  // registered/replaced later (or in tests) the key changes and we rebuild.
  // Rebuilding on EVERY call re-serialized every method's Zod schema just to find one
  // entry, which serialized concurrent docs_search/docs_open on the single-threaded
  // server and left them pending for seconds. Computing the name key is O(#services),
  // negligible next to a full catalog build.
  let cache: { key: string; entries: CatalogEntry[] } | null = null;
  function entries(): CatalogEntry[] {
    const deps = load();
    const key = sourceKey(deps);
    if (!cache || cache.key !== key) cache = { key, entries: buildCatalog(deps) };
    return cache.entries;
  }

  return {
    search(query, callerKind, opts) {
      const terms = tokenize(query);
      const limit = opts?.limit ?? 20;
      return entries()
        .filter((e) => isCatalogEntryVisible(e, callerKind))
        .filter((e) => (opts?.surface ? e.surface === opts.surface : true))
        .map((e) => ({ e, s: score(e, terms) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.e.qualifiedName.localeCompare(b.e.qualifiedName))
        .slice(0, limit)
        .map(({ e }) => ({
          id: e.id,
          surface: e.surface,
          qualifiedName: e.qualifiedName,
          title: e.title,
          ...(e.description ? { description: e.description } : {}),
        }));
    },
    get(id, callerKind) {
      const e = entries().find((entry) => entry.id === id);
      if (!e || !isCatalogEntryVisible(e, callerKind)) return null;
      return e;
    },
    listSurfaces(callerKind) {
      const counts = new Map<CatalogSurface, number>();
      for (const e of entries()) {
        if (!isCatalogEntryVisible(e, callerKind)) continue;
        counts.set(e.surface, (counts.get(e.surface) ?? 0) + 1);
      }
      return [...counts].map(([surface, count]) => ({ surface, count }));
    },
  };
}
