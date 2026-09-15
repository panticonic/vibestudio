# Tier & Session-Admission Audit Rubric (P2)

Status: companion to `capability-model-redesign.md` (D1/D2, phase P2). This rubric makes
the P2 classification audit mechanical-with-judgment: every service/DO method gets an
explicit tier (`open | gated | critical`) and every existing `code` declaration gets an
explicit session-admission decision. Gray-case rulings are recorded here as precedents
so later methods classify by analogy, not re-litigation.

## 1. Tier criteria

Apply the first rule that matches, top to bottom.

**critical** — any of:
- C1. Destroys or exports a secret (credential export/delete, key material).
- C2. Removes or weakens authority itself (grant revocation en masse, trust-policy
  changes, conduit blessing changes).
- C3. Irreversible destruction outside VCS protection (non-versioned stores, remote
  refs force-push, account deletion).
- C4. Methods whose **every invocation** is never-delegable under SA1 — i.e. the
  operation is critical regardless of arguments, resource, or grant state. SA1's
  `severityCriticalList` also contains *conditions* (credential shape, resource
  breadth, first-use state) that make some invocations of an otherwise-gated method
  critical; those stay **gated** at the tier level — the per-invocation severity
  verdict handles them at acquisition time. Tier is static admission; severity is a
  dynamic verdict. Collapsing the two would force permanent fresh-human confirmation
  onto whole methods whose ordinary invocations are routine.

**gated** — any of (and not critical):
- G1. Sends data outside the workspace or acts on external systems (network egress,
  email/webhook send, git push to external remotes, external URL open).
- G2. Uses a credential on the caller's behalf.
- G3. Mutates state whose blast radius exceeds the calling task's own scratch
  (workspace-wide settings, other units' storage, protected refs, membership,
  automation/mission definitions, unit install).
- G4. Reads data classes with out-of-band expectations of privacy from *code* even in
  a trusted household (browser data, stored-credential metadata, other users' device
  presence details) — the trusted-env rule is about *members*, not arbitrary code.
- G5. Internal-infrastructure methods that are host plumbing (boot manifests, runtime
  image stores, DO lifecycle, relay internals): gate them or `codeOnly`/host-restrict
  them — "harmless for the host but inappropriate for arbitrary code."

**open** — everything else. **Bias rule (trusted env):** when a method genuinely sits
between open and gated after applying G1–G5, it is **open**. Fear is not a criterion;
a concrete G-rule match is. The cost of a wrong `open` is bounded by the environment's
trust assumptions; the cost of a wrong `gated` is compounding prompt fatigue, which the
redesign treats as a defect.

Sub-rules:
- Read-only variants classify independently of their mutating siblings
  (`fs.readFile` open; `fs.writeFile` open *within the workspace tree* per precedent
  P-fs below).
- Tier is per method, but `deriveAuthorityResource` scope can split behavior: a method
  gated only for some resources (e.g. fs outside the workspace) is **gated** with an
  open fast-path expressed as a resource-scoped standing product rule — never two
  tiers for one method.

## 2. Session-admission procedure (existing `code` declarations)

For every method currently declaring `code`, decide `{code, session}` vs `codeOnly`:

1. Default **`{code, session}`** (user-confirmed default-include; eval is the front
   door).
2. Mark **`codeOnly`** only when the method's semantics depend on a *durable reviewed
   identity*: it binds state to the caller's code identity (per-unit storage handles,
   unit self-registration), participates in build/identity attestation, or manages the
   caller's own lifecycle. Rationale must be recorded per row.
3. A method that feels "too powerful for evals" but has no identity dependence is not
   `codeOnly` — power is what tiers are for. Gate it instead.

## 3. Seed precedents

| Method (schema) | Tier | Session | Rationale |
|---|---|---|---|
| `fs.readFile` / `readdir` / `readlink` / `open` | open | {code, session} | Workspace-tree reads; D8 governs content class, not access. |
| `fs.writeFile` (workspace tree) | open | {code, session} | Trusted-env bias; VCS-protected; blast radius = versioned tree. |
| `fs.*` outside workspace tree | gated | {code, session} | G3; resource-scoped split per §1 sub-rule. |
| `egress.fetch` (network) | gated | {code, session} | G1; scope default = origin (prompt spec §8). |
| `credentials.use` (fetch/git) | gated | {code, session} | G2. |
| `credentials.revokeCredential` / export paths | critical | {code, session} | C1/C2; fresh approval regardless of caller kind. |
| `permissions.list` | gated | {code, session} | Reads the authority map: G4-adjacent; cheap prompt, rare call. |
| `permissions.revoke` | critical | codeOnly→user/host surface | C2; redesign D13 drops `code` from permissionsService principals entirely. |
| `auth.revokeAgentCredential` | gated | codeOnly | Identity-lifecycle management: session admission adds nothing but risk; owner-extension/server semantics baked into the method. |
| `auth.getConnectionInfo` | open | {code, session} | Introspection. |
| `panels.*` (tree read/navigate/open) | open | {code, session} | Core UX; mutual inspectability is the product. |
| `docs.*` / catalog | open | {code, session} | Discovery must never prompt. |
| `externalOpen.open` | gated | {code, session} | G1 (leaves the workspace); origin-scoped. |
| `gitInterop.push` (external remote) | gated | {code, session} | G1; repo-scoped default. |
| `gitInterop` local ops | open | {code, session} | VCS-protected. |
| `settings.*` (workspace-wide write) | gated | {code, session} | G3. |
| `shellApproval.*` / `push.*` | gated→host/user | codeOnly | G5: approval plumbing is infrastructure; code never drives prompts directly. |
| `hostLifecycle.*` / `hubControl.*` / boot manifests | gated | codeOnly or host-restrict | G5. |
| `webhookIngress` registration | gated | {code, session} | G1-adjacent (opens an external listening surface). |
| `channel.*` post/read | open | {code, session} | R4 owns structural channel policy; content class rides messages (P4b). |
| `eval.run` | open | {code, session} | The front door; authority is governed inside, not at the door. |

Precedents are binding until amended here; a new gray case adds a row with rationale.

## 4. Output format: the tier table

Checked-in at `packages/shared/src/authority/tierTable.ts` (single source, imported by
dispatcher and catalog build; JSON-shaped const so the ledger generator can emit docs
from it):

```ts
export const METHOD_TIERS: Record<string, {
  tier: "open" | "gated" | "critical";
  session: "family" | "codeOnly";        // family = {code, session}
  rationale: string;                      // one line, cites a §1/§2 rule or precedent
  scopeSplit?: string;                    // resource rule for §1 split methods
}> = { "fs.readFile": { tier: "open", session: "family", rationale: "P-fs read" }, … }
```

Fail-closed rules (per D1): a dispatched method with no row → **build/registration
error** (not runtime default). CI check: every schema method has a row; every row's
method exists (no orphans); `critical` rows cross-checked against
`severityCriticalList` **one-directionally**: every critical-tier method must appear
in the never-delegable list (a critical method that SA1 could delegate is a
contradiction), but the reverse does not hold — never-delegable *conditions* on
gated methods do not promote those methods to critical (C4). The CI check asserts
`criticalTierMethods ⊆ neverDelegableMethods` only.

## 5. Process

Two-person-equivalent review (author + adversarial pass, matching the redesign's review
pattern); audit sweep ordered by schema file; expected volume ~40 schema files. Rows
land in one commit with the rubric version they were judged under; rubric changes after
the sweep re-open only rows citing the changed rule.
