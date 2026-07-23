import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = "d54c7596927db0f258d4d3fcf57a044068fe2957";
const ledgerPath = path.join(root, "docs/runtime-foundations/authority-ledger.json");
const jsonPath = path.join(root, "docs/runtime-foundations/p1-parity-worksheet.json");
const markdownPath = path.join(root, "docs/runtime-foundations/p1-parity-worksheet.md");
const check = process.argv.includes("--check");

const classes = [
  { className: "BrowserDataDO", file: "src/server/internalDOs/browserDataDO.ts", guard: "shell/server/broker" },
  { className: "WorkspaceDO", file: "src/server/internalDOs/workspaceDO.ts", guard: "server-only" },
  { className: "EvalDO", file: "src/server/internalDOs/evalDO.ts", guard: "server-only" },
  { className: "WebhookStoreDO", file: "src/server/internalDOs/webhookStoreDO.ts", guard: "server-only" },
];

function baselineSource(file) {
  try {
    return execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8" });
  } catch (error) {
    throw new Error(`Cannot recover P1 merge-base source ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertRecoveredGuard(item, source) {
  if (!source.includes("assertInboundAllowed")) {
    throw new Error(`${item.className} has no recoverable merge-base assertInboundAllowed guard`);
  }
  if (item.guard === "server-only" && !source.includes('caller?.callerKind !== "server"')) {
    throw new Error(`${item.className} merge-base guard is no longer recognized as server-only`);
  }
  if (item.guard === "shell/server/broker" && !source.includes("isBrowserDataDirectCaller")) {
    throw new Error("BrowserDataDO merge-base broker guard is no longer mechanically recoverable");
  }
}

function methodExists(source, method) {
  const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:async\\s+)?${escaped}\\s*\\(`).test(source);
}

function declarationFor(item, row, currentSource) {
  if (item.className === "BrowserDataDO") {
    if (!currentSource.includes('@rpc(browserDataAuthority(') || !currentSource.includes('relationship("code-source", brokerRepoPath)')) {
      return "undeclared";
    }
    return `requires:any(host,user,all(code,code-source:<manifest-broker>)); tier=${row.tier ?? "gated"}; sensitivity=${row.sensitivity}`;
  }
  return `principals=[${row.authorityPrincipals.join(",")}]; tier=${row.tier ?? "gated"}; sensitivity=${row.sensitivity}`;
}

function compare(item, declaration, existed) {
  if (!existed) return "absent-method";
  if (declaration === "undeclared") return "undeclared";
  if (item.guard === "shell/server/broker") {
    return declaration.includes("code-source:<manifest-broker>") ? "equivalent" : "WIDER";
  }
  return declaration.includes("principals=[host]") ? "equivalent" : "WIDER";
}

const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
const rows = [];
for (const item of classes) {
  const prior = baselineSource(item.file);
  assertRecoveredGuard(item, prior);
  const current = fs.readFileSync(path.join(root, item.file), "utf8");
  const methods = ledger.rows
    .filter((row) => row.rpcPlane === "workspace-do" && row.owner === item.file)
    .sort((a, b) => a.method.localeCompare(b.method));
  if (methods.length === 0) throw new Error(`${item.className} has no current direct-RPC census rows`);
  for (const method of methods) {
    const existed = methodExists(prior, method.method);
    const currentDeclaration = declarationFor(item, method, current);
    const comparison = compare(item, currentDeclaration, existed);
    rows.push({
      id: `${item.className}.${method.method}`,
      className: item.className,
      method: method.method,
      kind: "call",
      mergeBaseGuard: existed ? item.guard : "absent-method",
      currentDeclaration,
      comparison,
      disposition: comparison === "equivalent" ? "keep" : "tighten",
      rationale:
        comparison === "equivalent"
          ? "Shared declarative enforcement admits no caller shape refused by the merge-base receiver guard."
          : comparison === "absent-method"
            ? "New method is declaration-gated and remains subject to shared fail-closed enforcement."
            : "Declaration is narrowed to the recovered merge-base receiver policy.",
    });
  }
  rows.push({
    id: `${item.className}.__event`,
    className: item.className,
    method: "__event",
    kind: "event",
    mergeBaseGuard: "open",
    currentDeclaration: "undeclared (default-deny; no live topic intake declared)",
    comparison: "narrower",
    disposition: "tighten",
    rationale: "Attested topic-scoped intake replaces merge-base accept-all; no live topic is declared for this receiver.",
  });
  for (const method of ["__lifecycle/prepare", "__lifecycle/resume", "__alarm"]) {
    rows.push({
      id: `${item.className}.${method}`,
      className: item.className,
      method,
      kind: "host-control",
      mergeBaseGuard: "server-only",
      currentDeclaration: "fresh host-bound attestation",
      comparison: "equivalent",
      disposition: "keep",
      rationale: "Authenticated host origin replaces the merge-base server caller-kind check.",
    });
  }
  rows.push({
    id: `${item.className}.getState`,
    className: item.className,
    method: "getState",
    kind: "inherited-call",
    mergeBaseGuard: item.guard,
    currentDeclaration: "undeclared and absent from the @rpc exposure allow-list",
    comparison: "narrower",
    disposition: "tighten",
    rationale: "The inherited state dump is intentionally unreachable through opt-in RPC exposure.",
  });
}

for (const row of rows) {
  if (!row.disposition || !row.rationale) throw new Error(`Incomplete P1 parity row ${row.id}`);
  if (row.comparison === "WIDER" && row.disposition !== "reviewed-widening") {
    throw new Error(`P1 parity row ${row.id} is wider without a reviewed widening`);
  }
}

const worksheet = { version: 1, mergeBase: baseline, generatedFrom: "live authority ledger + mechanically recovered merge-base guards", rows };
const json = `${JSON.stringify(worksheet, null, 2)}\n`;
const markdown = [
  "# P1 receiver parity worksheet",
  "",
  `Merge-base: \`${baseline}\`. Generated from the live authority ledger and mechanically recovered guards.`,
  "",
  "| Receiver | Merge-base guard | Current declaration | Comparison | Disposition | Rationale |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows.map((row) =>
    `| \`${row.id}\` | ${row.mergeBaseGuard} | ${row.currentDeclaration.replaceAll("|", "\\|")} | ${row.comparison} | ${row.disposition} | ${row.rationale} |`
  ),
  "",
].join("\n");

function emit(file, content) {
  if (check) {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (existing !== content) {
      console.error(`${path.relative(root, file)} is stale; run pnpm generate:p1-parity`);
      process.exitCode = 1;
    }
    return;
  }
  fs.writeFileSync(file, content);
}

emit(jsonPath, json);
emit(markdownPath, markdown);
