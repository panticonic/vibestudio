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
cannot establish the amount saved by this change. A same-SDK comparison and
final published-pin installed measurements are still required.

Private bounded logs, profiles, and retirement receipts are retained outside the
repository under the operation's performance evidence directory. They are not
release artifacts or a reason to retain workspace databases and dependency trees.
