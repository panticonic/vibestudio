# Vibestudio security review — executive report

**Review date:** 2026-07-27\
**Review window:** repository revisions `9925c8d5` through `dd9b39a3`, plus the
uncommitted remediation working tree\
**Scope:** trusted host and service dispatch, runtime-to-runtime RPC, agent and
external-process execution, terminal/shell/filesystem boundaries, egress and
credentials, HTTP/WebSocket/webhook ingress, Electron panels, rich chat rendering,
local persistence, dependencies, update behavior, and release supply chain.

Detailed evidence is split into four reports:

- `docs/security-review-cross-cutting.md`
- `docs/security-review-agent-runtime.md`
- `docs/security-review-server.md`
- `docs/security-review-client-supply-chain.md`

### Post-review decisions and remediation

The owner subsequently made these architecture decisions:

- Linked Claude host visibility is an accepted risk until it can be replaced by an
  honest container boundary. Partial environment filtering is not treated as
  equivalent containment.
- The chat panel is intentionally the shared client-affine execution vessel for MDX
  and `client_eval`. The remediation is dynamic panel/worker authority, not a second
  MDX runtime or identity. See
  `docs/dynamic-vessels-and-userland-capabilities.md`.
- Terminal control should be the first receiver-enforced userland-defined capability.
- Shell approval/execution and process teardown, ingress/WebSocket budgets, the
  vulnerable `ws` graph, and release workflows were repaired in the review working
  tree.

## Executive conclusion

Vibestudio's host security foundation is meaningfully strong. Host services are
default-deny, grants authorize effects independently of bearer authentication,
Durable Object calls have exact method and code-identity contracts, credentials are
host-mediated and URL-bound, Electron views use sandboxing and context isolation, and
agent egress and external-content provenance are real platform mechanisms rather than
prompt conventions.

The review nevertheless found three major trust-boundary issues:

1. **The chat execution vessel has a broad fixed authority ceiling.** Completed MDX
   and `client_eval` intentionally execute inside the ordinary chat panel, but their
   authored execution is not dynamically admitted and scoped like eval. The intended
   fix is an optional dynamic-vessel mode that retains the panel identity while
   applying execution/session grants and provenance to each authored run.
2. **Linked headless Claude receives the extension principal and broad host
   visibility.** Its bubblewrap projection mounts the entire host read-only, preserves
   host networking, and inherits `process.env`, including the trusted extension RPC
   bearer. Read-only prevents writes but does not prevent secret disclosure,
   exfiltration, or extension impersonation.
3. **Direct RPC loses the original caller and creates a terminal deputy.** Any
   authenticated participant that can address a terminal panel can enumerate its
   sessions, read scrollback, and inject input into an existing PTY. The terminal then
   calls the shell as the legitimate session owner, bypassing the command-approval
   boundary.

These are not three isolated unsafe methods. They are instances of the same design
failure: a security-relevant fact is valid at one layer, then disappears at the next.
An authored chat execution lacks an execution-specific authority fact; the external
agent is given the launcher's ambient authority; and the original RPC principal is
replaced by an intermediary.

The right response is therefore not to remove rich messages, linked agents, terminal
automation, redirects, or cross-panel collaboration. It is to make the platform's
semantic contracts carry provenance, principal, audience, and exact intent through
every hop.

## Risk summary

| Priority | Finding                                                               | Severity | Disposition                                                                                        |
| -------- | --------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| P0       | Authored chat execution lacks execution-specific authority            | Critical | Dynamic-vessel design complete; implementation open                                                |
| P0       | Caller-blind direct RPC permits terminal read/injection               | Critical | Userland capability/receiver design complete; implementation open                                  |
| Accepted | Linked Claude can read host secrets and impersonate its extension     | Critical | Accepted until honest containerization                                                             |
| P1       | Redirect and DNS resolution escape initial URL/network authorization  | High     | Open                                                                                               |
| P1       | Shared relay HMAC proves global membership, not installation identity | High     | Per-install identity design direction selected; implementation open                                |
| Fixed    | Shell approval differed from shell execution                          | High     | Strict canonical intent landed                                                                     |
| Fixed    | Unauthenticated RPC/WS work could consume large amounts of memory     | High     | Typed pre-upgrade admission and bounded grant issuance landed                                      |
| Fixed    | Mutable release actions and broad release credentials                 | High     | Immutable pins and separated build/publish jobs landed; macOS packaging and signing remain coupled |
| P2       | OAuth client secrets can be sent to request-selected endpoints        | Medium   | Open                                                                                               |
| P2       | Webhook JWKS retrieval is an unconstrained server-side fetch          | Medium   | Open                                                                                               |
| Fixed    | Direct webhook bodies were buffered without a ceiling before lookup   | Medium   | Persisted per-subscription budgets and lookup-first bounded reads landed                           |
| P2       | Unknown Electron permissions default to allow                         | Medium   | Open                                                                                               |
| P2       | Context-menu external opening bypasses the canonical URL policy       | Medium   | Open                                                                                               |
| P2       | Agent scope is stored as plaintext in context-shared origin storage   | Medium   | Open                                                                                               |
| P2       | Self-update package lifecycle inherits the entire app environment     | Medium   | Open                                                                                               |
| Fixed    | Shell timeout did not own or reliably terminate a process tree        | Medium   | Bounded process-tree teardown landed                                                               |

The generic direct-RPC boundary is rated Medium in isolation in the server report
because impact depends on the receiver. Its verified composition with the current
terminal receiver is Critical and should be prioritized at that higher severity.
Likewise, the `ws` advisory has a high upstream scanner rating but loopback binding
reduced its remote reach at the reviewed revision. The working tree now pins every
production `ws` major to a patched floor and rejects direct RPC upgrades unless the
client first obtains a short-lived, one-use typed admission grant.

## Recommended architecture

### 1. Receiver contracts with original-caller propagation

Extend the authority vocabulary already used by host services and Durable Objects to
every cross-runtime receiver:

- each exposed method declares accepted principal shapes, relationship requirements,
  semantic capability/effect, resource derivation, and receiver build/incarnation;
- the gateway evaluates the declaration against the transport-authenticated original
  caller;
- intermediaries propagate a host-authenticated delegation chain instead of
  substituting their own identity;
- sensitive resources such as a terminal session are represented by scoped,
  intentionally delegable handles.

Keep `runtime.expose()` and panel handles ergonomic. Open collaborative methods can
explicitly declare that they are open. Local terminal typing remains prompt-free, and
authorized same-task automation can use a standing session/version grant. A prompt is
needed only when authority actually widens.

This single design resolves the terminal deputy, the underlying default-open runtime
relay, direct `_agent.*` bypasses of `panelTree.callAgent`, and future receiver-specific
variants without a method blacklist.

### 2. Dynamic execution vessels and userland-defined capabilities

Keep MDX and `client_eval` in the chat panel: sharing its DOM, transport, storage, and
client-affine runtime is the product purpose of that panel. Do not invent a second MDX
runtime, principal, or EvalDO hop. Instead, allow an exact panel or worker build to
declare `dynamic-vessel` authority:

- the runtime keeps its existing identity;
- each authored execution carries a short-lived, host-attested fact bound to exact
  source, panel build/incarnation, agent, context, lineage, and task;
- that fact replaces only the fixed code-manifest request ceiling;
- grants, locks, tier, lineage, receiver contracts, and resource checks still apply;
- framework activity without a live execution fact retains only a small fixed
  baseline.

Make the same authority evaluator accept sealed, provider-namespaced userland
capability definitions. Definitions derive resources declaratively and supply bounded
approval copy, while the host owns identity chrome, approval policy, grants, audit,
and receiver enforcement. Terminal session handles are the first migration:
`terminal.create`, `terminal.read`, `terminal.input`, and `terminal.admin`. This
preserves prompt-free local typing and ergonomic same-task automation while making
authority widening explicit. The complete cutover design is in
`docs/dynamic-vessels-and-userland-capabilities.md`.

### 3. One contained-process and executable-intent model

Create a host-owned process abstraction shared by external agents, shell execution,
PTYs, and helpers. It should own:

- an explicit minimal filesystem projection rather than `--ro-bind / /`;
- a cleared, allowlisted environment with no ambient extension/service bearer;
- mediated, attributed network access;
- a process group or Windows Job Object with bounded teardown;
- one canonical executable intent.

Model execution as either direct `argv` or an exact script. The same canonical bytes
and behavior-affecting environment must be displayed, hashed, audited, and executed.
That preserves shell expressiveness while making approval truthful.

### 4. Resolved-and-authorized outbound HTTP

Route proxy fetch, streaming fetch, Git, OAuth, OIDC/JWKS, and future server-side
requests through one client that:

- normalizes and authorizes the semantic URL audience;
- resolves and classifies every candidate address;
- pins an allowed address while retaining correct TLS SNI/Host;
- follows redirects manually and reauthorizes every hop;
- rebuilds credentials for the new destination instead of carrying headers forward;
- enforces time, hop, response, and decompression budgets.

Same-audience redirects remain silent. Only a hop that widens URL, credential, or
private-network authority should prompt. Provider configuration should become a
versioned trust bundle whose authorize/token/device/JWKS roles are reviewed once, so
ordinary account connections do not repeatedly expose raw endpoint decisions.

### 5. Staged ingress and cryptographic installation identity

The working tree now establishes the reusable ingress boundary for HTTP and local
WebSocket RPC. `POST /rpc/ws-admission` has an empty body, resolves credentials under
bounded concurrency, and issues a short-lived, one-use grant; the WebSocket upgrade
accepts only that grant. Webhook subscriptions likewise carry an explicit persisted body
budget.

Continue applying the shared staged-ingress primitive across remaining control lanes:

- authenticate headers or a small fixed-size first frame before large reads;
- apply small unauthenticated ceilings;
- enforce per-principal and aggregate in-flight budgets after admission;
- direct large values to streaming/CAS paths with backpressure.

Preserve the patched `ws` floors and explicit protocol-specific payload limits
independently of the admission design.

Replace the callback relay's global HMAC identity with an installation-specific key
pair and challenge-response reconnect. Enrollment can remain automatic, and normal
reconnects remain prompt-free; the relay then proves a stable tenant identity instead
of accepting a caller-provided `serverId` under a population-wide secret.

### 6. Capability-derived desktop and release policy

Consolidate client policy instead of maintaining handwritten exceptions:

- derive Electron permissions and panel CSP from declared surface capabilities;
- deny unknown permission names and require a typed policy entry for new ones;
- route every external-open path through one normalized `ExternalTarget` service;
- keep authority-bearing agent state in a host service and persist opaque handles in
  the renderer;
- pass a minimal environment to update package lifecycle code.

For releases, pin third-party Actions by full commit SHA, give jobs explicit minimal
permissions, and separate secret-free builds from digest-verifying publication. The
current macOS `electron-builder --mac` path couples packaging, signing, and
notarization; a genuinely isolated signing job requires a packaging redesign, not a
nominal workflow split.

## Delivery sequence

### P0 — before treating the current build as a safe multi-principal agent platform

1. Implement dynamic-vessel admission for chat panels and optionally workers; bind
   MDX and `client_eval` to exact authored execution facts.
2. Implement receiver-enforced userland capabilities and migrate terminal and other
   userland approval gates in one monorepo-wide cutover.
3. Preserve the original caller/delegation chain across receiver calls, including
   terminal-to-shell effects.

Linked Claude containment is explicitly outside this milestone as an accepted risk
until the product adopts an honest container boundary.

### P1 — next security milestone

1. Introduce the resolved-and-authorized HTTP client and migrate egress redirects.
2. Replace relay tenant identity with per-install cryptographic identity.
3. Finish the macOS packaging redesign required to isolate signing from compilation.
4. Add artifact attestations/SBOMs after the signing boundary is structurally honest.

Canonical shell intent, bounded process teardown, typed HTTP/WebSocket admission,
subscription-specific webhook ingress, the monorepo-wide `ws` upgrade, immutable Action
pins, and build/publish separation are complete in the review working tree.

### P2 — consolidate on the new primitives

Migrate OAuth endpoint trust, JWKS retrieval, Electron permissions,
external opening, updater environment, renderer persistence, and process teardown.
Add durable/redacted diagnostics and audit receipts without reducing the observability
needed for agentic debugging.

## Required regression properties

Security work should prove both denial and preserved UX:

- model-authored rich content renders all supported components but cannot evaluate
  JavaScript or reach globals;
- linked agents can authenticate to the intended provider and scoped Vibestudio
  bridge, but cannot read unrelated host paths or discover/replay host bearers;
- an unrelated runtime cannot inspect or control a terminal, while a properly
  delegated same-task runtime can do so without per-keystroke prompts;
- shell approval previews exactly the executed script/argv and behavior-affecting
  environment;
- redirects inside an existing audience are silent, while authority-widening hops are
  denied or approved exactly once;
- invalid RPC/WebSocket/webhook admissions are rejected before large body/frame
  consumption;
- reconnecting the same installation works without prompts, while another
  installation cannot claim its relay identity;
- release signing consumes only a previously produced exact artifact digest.

Headless system tests should use the existing host-attested test authority, not a
production bypass or prompt-script special case.

## Controls to preserve

The review explicitly verified these strengths:

- undeclared host service methods and promptable methods without authority metadata
  fail closed;
- caller identity is transport-derived rather than trusted from RPC envelopes;
- admin token comparison is constant-time and unconfigured admin access fails closed;
- connection grants are random, single-use, incarnation-bound, and revocable;
- Durable Object dispatch checks exact method catalogs, active code identity, and host
  attestation;
- agent model credentials remain server-side and worker egress is attributed;
- external-content ingestion advances a durable provenance latch;
- filesystem mutations use live context and causal authority checks;
- Electron panel/shell views disable Node integration and enable context isolation and
  sandboxing;
- credential records use authenticated encryption and restrictive file modes;
- system-test artifacts default to restrictive permissions.

These are the foundation for the proposed synthesis. Remediation should extend them,
not introduce a parallel security channel.

## Validation and limits

The review combined independent source tracing across server, agent/runtime, and
client/supply-chain surfaces with cross-cutting verification.

- The central focused authority/RPC/egress/credential suite passed 139 tests.
- The agent/runtime suite passed 139 tests. Its live bubblewrap read-only-filesystem
  assertion is skipped only when a probe confirms that the current kernel cannot
  create the required user namespace; production launch behavior remains fail-closed.
- Eleven focused eval-confinement and system-test controls passed.
- Typed WebSocket admission passed 340 tests across 15 focused host files plus
  host/workerd and workspace desktop/integration/mobile typechecking.
- Subscription-specific webhook budgets and truthful headless CDP diagnostics passed
  79 tests across six focused files.
- Production dependency audits were triaged for reachability rather than treating all
  scanner labels as equivalent. Every `ws` 6/7/8 line in both monorepo lockfiles now
  resolves to its patched release floor.
- The final monorepo gate passed its documentation, authority, release-policy, build,
  host, browser, userland, and mobile components. The final userland run passed 3,221
  tests with two environment-gated skips; mobile passed 168 tests. The host run's one
  live bubblewrap skip is the kernel-probed case described above.
- No destructive exploit was run against a live terminal, credential store, relay, or
  external service.

The review began at `9925c8d5`. During it, `main` advanced to `dd9b39a3` with panel
snapshot authority, build-cache, performance, and documentation changes. The
remediations described above are an uncommitted working-tree delta on that revision.
Focused current-HEAD checks remain part of the acceptance gate.

This is a source and local-test security review, not a penetration-test certificate.
Cloud deployment policy, production secret distribution, signing-provider controls,
and every approval's final rendered UI were not externally exercised.
