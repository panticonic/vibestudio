# Dev loop

Extension source participates in the workspace-wide semantic VCS. Read
[vibestudio-vcs](../vibestudio-vcs/SKILL.md) before changing it. A successful
protected publication of a committed workspace event is the dev signal; the
projected filesystem and derived build are not parallel sources of truth.

## The flow

1. Call `vcs.status`, retain the exact working head, and author managed source
   edits with that basis and stable command IDs.
2. Run the ordinary typecheck, tests, and build service for the current context;
   inspect structured `file:line:col` diagnostics.
3. If current `main` has relevant changes, compare its exact event and integrate
   them in small deliberate local steps.
4. Commit the complete local application chain.
5. Publish the clean committed event through `vcs.push`, which validates
   semantic ancestry/integration, obtains publication approval, and atomically
   advances protected refs.
6. The `main` advance triggers a separate extension build projection and
   extension-specific update approval.
7. Only after a successful build and update approval may the manager replace
   the process and run `activate(ctx)`. A build, validation, approval, or
   activation failure leaves the previous extension active.

An ancestry, integration, publication-approval, or atomic-ref refusal advances
no protected ref. A later build or activation failure does not roll publication
back; repair it with a new semantic event. There is no save-file hot reload,
marker merge, or force path.

## Dev-session approval

The source approval offers three choices:

- **Allow update** — accept this source update.
- **Reject update** — decline runtime activation and keep the old extension
  running; the source event remains published.
- **Allow extension updates to `<name>` without asking, for the next 4 hours** — the dev-session grant. Stored against the extension identity and consulted before re-prompting.

Pick dev-session while actively iterating. It expires automatically; the next source update outside the 4h window prompts again.

This is the one place the extension trust model loosens for ergonomics. Source
updates for extensions are privileged — review what you're pushing before
granting a session.

## Pushing from a panel or worker

Panels and workers use the same semantic VCS protocol as every other caller.
Use the canonical skill and live `help("vcs")` schema; do not embed a separate
extension-specific call sequence. The first protected publication can prompt;
subsequent updates within an approved dev session can auto-accept.

## Inspector (dev mode only)

In dev mode each extension process is launched with `--inspect=0` (random port). The inspector URL surfaces on `workspace.units.list()` and `workspace.units.inspector(name)`:

```ts
const info = await workspace.units.inspector("@workspace-extensions/hello");
// { url: "ws://127.0.0.1:48273/abc-…" }
```

Opening that URL attaches Chrome DevTools to the extension process. Sourcemaps are inlined (required), so breakpoints land in the original TypeScript.

In production mode (`VIBESTUDIO_PROD=1` or `NODE_ENV=production`), `--inspect` is disabled and `inspector(name)` returns `null`.

## Status, health, logs

The unified status surface (`workspace.units.list()`) is the right tool for "is my extension running" introspection. It returns one row per workspace unit (panels, workers, extensions) with:

- `status` — lifecycle: `running`, `stopped`, `building`, `error`, `pending-approval`
- `health` — self-reported operational state (see `ctx.health` in [AUTHORING.md](AUTHORING.md))
- `respawn` — when the manager is mid-backoff after a crash, this shows `{ attempts, nextAttemptAt }`
- `pendingApproval` — set when a declaration/update approval is in flight
- `availableUpdate` — set when current workspace state would change the extension's runtime inputs (a dependency source update, an external-dep bump)
- `lastBuiltAt` — best-effort epoch ms of the active bundle
- `lastError` — populated on `error` status
- `inspectorUrl` — dev-only

`workspace.units.logs(name, { since?, level?, limit? })` returns recent log records for any unit. `workspace.units.diagnostics(name, { limit?, errorLimit?, since?, level? })` returns the same bounded log stream plus a separate error-only buffer, dropped counts, and the current unit status row.

Extension records from `ctx.log`, extension process stdout/stderr, worker/DO `console.*`, and panel lifecycle diagnostics share the same persisted diagnostic history. The history is retained under the workspace state directory with separate bounds for general logs and errors, so noisy info logs do not evict the error trail.

If the extension log only shows a symptom, inspect the workspace server host
logs for manager/reconcile/build/routing failures: `services.serverLog.query(...)`
from eval, or the `about/server-logs` live viewer. The full host-log follow
pattern is in `../server-logs/SKILL.md`.

## Restart without a source change

```ts
await extensions.reload("@workspace-extensions/hello");
```

Approval-gated. Restarts the _currently active approved build_ — does not pull dependency changes. Use this after editing in-process state (env vars, on-disk config) that the extension reads at `activate()` time.

To adopt dependency changes (a `@workspace/runtime` push, an `npm` version bump), the extension must rebuild — and rebuilds happen only on reconcile, at workspace startup or when `meta/vibestudio.yml` is pushed into its `main`. `extensions.reload(name)` restarts the _active approved build_ and does **not** rebuild, so it won't pick up dependency changes on its own, and dependency pushes don't auto-reload a running extension either.

## Common failure shapes

| Symptom                             | Cause                                                                     | Fix                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `MANIFEST_KIND`                     | `package.json` is missing `vibestudio.extension` (or has two kind blocks) | Add exactly one `vibestudio.extension` block                                  |
| `MANIFEST_ACTIVATION`               | `activationEvents` is not `["*"]`                                         | Lazy activation is future work — must be `["*"]` in v1                        |
| Stays in `error` after update       | `activate()` threw                                                        | Check `lastError` on `workspace.units.list()`; look at the inspector log      |
| `Cannot find module ...` at runtime | Dep was externalized but missing from runtime install                     | Set `dependencyMode: "external"` and confirm the package is in `dependencies` |
| `Named export ... not found`        | ESM imported a named export from a CJS package                            | Use `import pkg from "x"; const { fn } = pkg;`                                |
| `require is not defined`            | Code crossed an ESM/CJS boundary in a bundled dep                         | Switch the dep to `dependencyMode: "external"`                                |
| 503 from `/_r/ext/<name>/*`         | Extension is `pending-approval`, `building`, or `error`                   | Approve the declaration/update or check `lastError`                           |
| 413 from fetch endpoint             | Request body exceeded 32 MB                                               | Split the upload or stream to disk via `ctx.fs`                               |

## Remove a Declaration

Remove the extension's entry from `meta/vibestudio.yml` through the semantic
adapter, commit the complete local application chain, and publish the resulting
workspace event. The next reconcile stops the process and deletes its
registry entry; per-extension storage scratch remains. Remove source separately
when requested. Approval grants remain keyed by `(principal, extension-name)`;
re-declaring the same identity reuses them. The declared set is authoritative.
