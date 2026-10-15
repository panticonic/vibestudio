# Production and developer startup follow-up

## Boundary and input ownership

The target is a usable hosted shell, not the native splash or a listening
process. Record the restored workspace layout and catalog, then independently
verify semantic activation through the native startup profile. An actionable
first-use consent prompt is not a startup spinner and is not answered to move
the readiness timestamp.

Keep release production outside installed-app startup. The package must contain
the complete prepared release for its actual host fingerprint and published
template pins; a fresh consumer must reuse that release through the ordinary
installed validation path. Developer startup intentionally differs: source
publication admits the foreground while the same producer continues the full
runtime batch. Background compilation remains part of dev's measured host load.

The dependency edges are:

- Local source checkpoints and host prerequisites are independent. Their join
  admits immutable source publication; consumers need that publication, not the
  unrelated full runtime batch.
- Release consumers need the exact sealed artifact. Producer verification and
  fresh-install reuse checks remain required publication gates.
- Schema evidence is collected by the existing canonical probe during release
  verification. Publish its installation component only after all producing
  clients and services have joined. Consumers read the component once and bind
  its evidence to their current execution; actual storage admission is unchanged.
- Workerd's immutable program capture precedes configuration and process spawn.
  HTTP readiness precedes semantic attachment. Separate internal services keep
  separate isolates, storage namespaces, and authority.
- Internal executable publication proves the catalog-derived per-class outputs
  once. Installed metadata admission does not initialize the producer's hash or
  dependency-policy work; the full producer and final artifact gates remain.
- A protected-main publication's host observers must finish before semantic
  acknowledgement. Recovery replays the same durable publication, including a
  previously acknowledged head whose observers did not finish. It does not
  manufacture a host launch record or grant new publication authority.
- Shutdown joins RPC producers before transports, then retires the owned hub.
  A failed earlier step does not skip later retirements. Independent failures
  remain observable; only the exact owner's cancellation is acknowledged as
  cancellation.

## Evidence collected so far

The baseline package passed its production build and artifact gates, including
108 exact fresh-install runtime artifact reuses. Its restored-shell display
times were 8.67 s fresh state and 5.12 s existing state. **Neither is a healthy
app-readiness result:** System semantic activation failed because the durable
host-launch record was missing. The same failure stranded shutdown. Its private
diagnostic processes were explicitly retired and joined, failure evidence was
retained, and its private scratch cache was removed.

After repairing publication recovery, developer samples with fresh ephemeral
workspaces and the ordinary inherited local cache displayed the restored shell
in 13.54 s and 12.77 s. Both workspaces emitted successful semantic activation;
the native CLI startup profile was also collected. This is not a cold-cache
measurement, nor proof that the 5–10 s target has been met. Shutdown exposed a
separate events-watch cancellation propagation defect, now covered by focused
dispatcher and real transport tests. Both diagnostic launches joined; their
private scratch was removed and the shared cache was preserved.

An attributed Workerd bootstrap took 1.62 s. Its first generation spent 1.14 s
from spawn to HTTP readiness, compared with 55 ms preparing configuration,
2 ms serializing it, and 15 ms writing module payloads. Equal module payloads
were referenced 12.88 MB in total but written only once (3.24 MB). This points
to executable/isolate initialization, not configuration I/O, as the larger next
contributor. These are phase observations, not an end-to-end speedup claim.

The new shell's nine optional settings/chooser entry chunks are marked lazy
in the sealed build report and absent from both actual startup resource lists.
Pairing listeners, core shell UI, and first-use reporting consent remain eager.
Its initial bundle is 2,985,936 bytes across 88 requests; the old production
artifact used a different SDK/dependency fingerprint, so its 3,226,201 bytes
cannot establish the amount saved by this change. The subsequent same-instance,
same-SDK canonical context comparison verified exact cache keys and reduced
initial JavaScript from 2,273,077 to 2,171,967 bytes (4.45%). Total initial bytes
fell 101,110 bytes (3.28%), while initial requests increased from 76 to 88 and
the whole emitted bundle grew 45,668 bytes. These are byte-attribution results,
not an end-to-end speedup claim. Both comparison contexts, its private local Git
clone, and its client were retired. Final published-pin installed measurements
are still required.

## Native publication prerequisite

Normal System composition verification exposed a real native runtime API defect
before publication. The former checkout-wide mobile check covered the
Node/Jest test environment but lacked a separate Hermes app program, masking
unsupported cancellation methods. The corrected check validates the actual app
without browser or Node globals and with native conditional package exports;
Node/Jest tests keep their own real runtime's types. SDK consumers resolve real
package exports rather than the host implementation's source aliases.
The runtime repair belongs to the existing mobile platform initialization shared
by the installed bootstrap and downloaded shell, not individual call sites.
That boundary now also owns a standards-compliant streaming/fatal UTF-8 decoder;
the earlier minimal decoder ignored those options. Native declarations describe
the APIs actually supplied by Hermes and the installed polyfills, not an assumed
browser environment. Portable report and panel-operation identity hashing use
the existing content digest implementation rather than requiring unavailable
native WebCrypto, preserving the same digest bytes. The obsolete mobile
filesystem stub and its bundler aliases are removed: unsupported imports must
fail the real native build, not pretend that the filesystem is empty.

Channel and event consumers use the existing portable readable-body RPC primitive;
React Native's `Response` is not a streaming-body adapter. Caller projections must
preserve that primitive through the same schema validation and owned lifecycle.
Host and template callers change together; no old-contract compatibility layer or
version-bump detour is retained. The shared panel core likewise requires its
existing RPC metadata dependency instead of falling back to a local filesystem.

Two mobile RPC descriptor imports also reached server implementations through
type-only worker contracts. Mobile now consumes the public channel ABI. Quickfire's
descriptor belongs beside its existing platform-neutral client interface in Base;
the worker implements that same interface and clients import the public
descriptor directly. The obsolete worker contract re-export is removed, and the
desktop shell also consumes the public channel client ABI rather than its
worker's implementation contract.
Consequently the exact checked Base release must be published before the final
System release can consume its new public export. Both releases retain their
normal review and publication gates. These prerequisite fixes are not startup
speed measurements.

The task worktrees were subsequently synchronized with current local main in
the host, Base, and System. Main's terminal and platform-neutral lineage-store
owners are retained; their actual callers use the same required readable-body
contract. Retired Ink/WASM worker paths remain removed. After synchronization,
the four host typecheck programs and the three System composition programs
(desktop, native app, and Node/Jest) pass. The merged host's seven focused
regression files pass 226 tests; the three affected System terminal files pass
43 tests. The earlier failed managed bootstrap used a stale Base snapshot with
no PTY package, while the current catalog test tooling already required it;
that instance was stopped and its temporary state retired. None of these
correctness checks establishes a startup latency improvement.

The canonical native build subsequently produced both Android and iOS bundles
without diagnostics, and an immediate verification reused the same build key.
Both the profile context and its client retired successfully. The existing
per-file native ownership policy declares the actual globals initializer; it
does not admit arbitrary callers. Neither the development Metro config nor the
installed provider retains a fake-filesystem alias. A genuinely cold source
producer also exposed a publication-stage ownership inversion: recipe records
were required before their publisher created them. The pre-seal check now
validates producer payloads, while final sealed-generation validation still
requires the publication records. Fifteen focused generation tests and the real
cold source build pass.

The remaining manually assembled clients were migrated in Personal and the
development system-testing template too. Personal's collection boundary and
browser-data extension forward the real readable primitive; its dead
`apps:status` observation is removed. The system-test fault injector uses one
fault policy for calls and both genuine stream capabilities, preserving the
owning transport, cancellation options, and raw body identity. Personal passes
37 focused cases and composition typechecking; system-testing passes 65 focused
cases and composition typechecking. Their source worktrees, like Base and
System, are committed and clean; original checkouts are unchanged.

The prepared Base 0.3.93 publication review contains exactly 29 changed paths
against upstream `8a7a1113d344baeb9846b5a0fc2de38d7265aa8d`. All 27 old and 28 new
Git blobs and modes match checked source
`f543603921778ba0852c5c361809138f206540c3`, including deletion of the obsolete
Quickfire worker contract. No release has been published: exact release approval
precedes Base publication, followed by dependent Personal/System releases and
final installed production measurements. All diagnostic instances and owned
scratch are retired while waiting; inherited shared caches remain intact.

Private bounded logs, profiles, and retirement receipts are retained outside the
repository under the operation's performance evidence directory. They are not
release artifacts or a reason to retain workspace databases and dependency trees.
