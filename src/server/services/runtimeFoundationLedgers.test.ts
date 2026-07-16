import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_DIRECT_AUTHORITY_CAPABILITIES } from "./productDirectAuthorityCapabilities.generated.js";
import { productCodeHasCapability } from "./productAuthorityGrants.js";

interface AuthorityRow {
  id: string;
  rpcPlane: "host-service" | "workspace-do";
  resourceDerivation: { kind: string };
  currentOutcomes: { allowed: string; denied: string };
  predicates: string[];
  r3aRequirement: string;
  r3b: { review: string; change: string | null };
  parityAssertion: string;
}

const root = process.cwd();
const readJson = <T>(relativePath: string): T =>
  JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")) as T;

function productionTypeScriptFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test.")
      ? [absolute]
      : [];
  });
}

function directRpcIds(): string[] {
  const patterns = [
    /@rpc\(\{\s*principals:\s*\[[^\]]*\][\s\S]*?\}\)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g,
    /@rpc\([A-Z][A-Z0-9_]*\)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g,
  ];
  return ["src/server/internalDOs", "workspace/workers", "workspace/packages"]
    .flatMap((directory) => productionTypeScriptFiles(path.join(root, directory)))
    .flatMap((file) => {
      const owner = path.relative(root, file).replaceAll(path.sep, "/");
      const source = fs.readFileSync(file, "utf8");
      return patterns.flatMap((pattern) =>
        [...source.matchAll(pattern)].map((match) => `direct:${owner}:${match[1]}`)
      );
    })
    .sort();
}

describe("runtime foundation ledgers", () => {
  const authority = readJson<{ version: number; rows: AuthorityRow[] }>(
    "docs/runtime-foundations/authority-ledger.json"
  );

  it("host-authority-census: accounts for every host service method exactly once", () => {
    const serverAuthorityMatrix = readJson<Record<string, { methods: Record<string, unknown> }>>(
      "src/server/services/__serviceAuthorityMatrix.golden.json"
    );
    const mainAuthorityMatrix = readJson<Record<string, { methods: Record<string, unknown> }>>(
      "src/main/services/__serviceAuthorityMatrix.golden.json"
    );
    const expected = [
      ...new Set(
        Object.entries({ ...serverAuthorityMatrix, ...mainAuthorityMatrix }).flatMap(
          ([service, entry]) =>
            Object.keys(entry.methods).map((method) => `host:${service}.${method}`)
        )
      ),
    ].sort();
    const actual = authority.rows
      // Composite requirements add schema-owned leaf rows with `#<leaf>` ids;
      // the unsuffixed row is the one-to-one method census entry.
      .filter((row) => row.rpcPlane === "host-service" && !row.id.includes("#"))
      .map((row) => row.id)
      .sort();
    expect(actual).toEqual(expected);
  });

  it("direct-authority-census: accounts for every direct RPC method exactly once", () => {
    const actual = authority.rows
      .filter((row) => row.rpcPlane === "workspace-do")
      .map((row) => row.id)
      .sort();
    expect(actual).toEqual(directRpcIds());
    expect(PRODUCT_DIRECT_AUTHORITY_CAPABILITIES).toEqual(
      [
        ...new Set(
          authority.rows
            .filter((row) => row.rpcPlane === "workspace-do")
            .map((row) => `rpc:${row.id.slice(row.id.lastIndexOf(":") + 1)}`)
        ),
      ].sort()
    );
  });

  it("keeps the eval kernel grant set minimal but lifecycle-complete", () => {
    const kernel = [
      "service:blobstore.getText",
      "service:blobstore.putText",
      "service:eval.beginCleanup",
      "service:eval.renew",
      "service:events.unsubscribeAll",
      "service:workspace-state.alarmClear",
      "service:workspace-state.alarmSet",
    ];
    for (const capability of kernel) {
      expect(productCodeHasCapability("product/eval", capability), capability).toBe(true);
    }
    // Source/import/build and every user operation travel through a preparation
    // or run invocation credential. Blobstore is the narrow exception: the
    // kernel owns immutable run bundles and persistent scope spill records.
    for (const capability of [
      "service:build.getBuild",
      "service:fs.readFile",
      "service:externalOpen.openExternal",
    ]) {
      expect(productCodeHasCapability("product/eval", capability), capability).toBe(false);
    }
  });

  it("makes every authority decision concrete and reviewable", () => {
    expect(authority.version).toBe(1);
    expect(new Set(authority.rows.map((row) => row.id)).size).toBe(authority.rows.length);
    for (const row of authority.rows) {
      expect(row).not.toMatchObject({ sensitivity: "unknown" });
      expect(row.resourceDerivation.kind).toMatch(/literal|argument|prepared|direct-target/);
      expect(row.currentOutcomes.allowed).not.toBe("");
      expect(row.currentOutcomes.denied).not.toBe("");
      expect(row.predicates.length).toBeGreaterThan(0);
      expect(row.r3aRequirement).not.toMatch(/TODO|unknown|anyOf\(\)/i);
      expect(row.r3b.review).toMatch(
        /unchanged-parity|schema-owned-additional-leaf|schema-owned-prepared-leaf/
      );
      expect(row.r3b.change).toBeNull();
      const assertionFile = row.parityAssertion.split("#", 1)[0]!;
      expect(fs.existsSync(path.join(root, assertionFile)), assertionFile).toBe(true);
    }
  });

  it("covers every executable adoption surface with exact provenance", () => {
    const ledger = readJson<{
      version: number;
      rows: Array<{
        surface: string;
        executableIdentity: string;
        selector: string;
        adoption: string;
        provenance: string[];
        parityAssertion: string;
      }>;
    }>("docs/runtime-foundations/execution-update-ledger.json");
    const required = [
      "runtime.createEntity",
      "ensureDurableObjectEntity",
      "workerd.startWorker",
      "eval-do",
      "vcs-store",
      "agent-spawn",
      "panel",
      "electron-app",
      "react-native-app",
      "terminal-app",
      "extension",
      "dev-host-current-client",
      "dev-host-isolated",
      "claude-code",
    ];
    const surfaces = new Set(ledger.rows.map((row) => row.surface));
    for (const surface of required) expect(surfaces.has(surface), surface).toBe(true);
    for (const row of ledger.rows) {
      expect(row.executableIdentity).toBe("full-execution-digest");
      expect(row.selector).not.toBe("");
      expect(row.adoption).not.toBe("");
      expect(row.provenance).toEqual(
        expect.arrayContaining(["source-state", "artifact-digest", "execution-digest"])
      );
      expect(fs.existsSync(path.join(root, row.parityAssertion))).toBe(true);
    }
  });

  it("records the complete channel lifecycle contract", () => {
    const ledger = readJson<{
      version: number;
      rows: Array<{ behavior: string; contract: string }>;
    }>("docs/runtime-foundations/channel-behavior-ledger.json");
    expect(ledger.rows.map((row) => row.behavior)).toEqual(
      expect.arrayContaining([
        "creation",
        "first-subscribe",
        "subsequent-subscribe",
        "invitation",
        "visibility",
        "presence",
        "presentation-mutation",
        "fork-clone",
        "owner-loss",
        "deletion",
        "reconnect",
        "system-agent",
      ])
    );
    expect(ledger.rows.every((row) => row.contract.length > 0)).toBe(true);
  });

  it("bootstrap-acyclic: has one sealed root and no forbidden product service above it", () => {
    const graph = readJson<{
      root: string;
      nodes: Array<{ id: string }>;
      edges: Array<[string, string]>;
      forbiddenAboveRoot: string[];
    }>("docs/runtime-foundations/bootstrap-dependency-graph.json");
    const ids = new Set(graph.nodes.map((node) => node.id));
    const incoming = new Map([...ids].map((id) => [id, 0]));
    const outgoing = new Map([...ids].map((id) => [id, [] as string[]]));
    for (const [from, to] of graph.edges) {
      expect(ids.has(from)).toBe(true);
      expect(ids.has(to)).toBe(true);
      outgoing.get(from)!.push(to);
      incoming.set(to, incoming.get(to)! + 1);
    }
    const queue = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
    const visited: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      visited.push(id);
      for (const next of outgoing.get(id)!) {
        incoming.set(next, incoming.get(next)! - 1);
        if (incoming.get(next) === 0) queue.push(next);
      }
    }
    expect(visited).toHaveLength(ids.size);
    expect(graph.root).toBe("verified-product-boot-manifest");
    expect(graph.forbiddenAboveRoot).toEqual(
      expect.arrayContaining(["EvalDO", "VCS product service", "System Agent"])
    );
  });
});
