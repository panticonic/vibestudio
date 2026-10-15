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
Quickfire worker contract. Following the user's exact-release approval, a fresh
normal authoring review reproduced that same inventory, manifest, source blobs,
and byte-identical diff before publication. Base 0.3.93 is published at
`b6a28e2bfb9664059220ae85b64c958c987b32d9` (`refs/tags/v0.3.93`). Its real Git tag
was fetched normally and the canonical source cache admitted that published
snapshot from a private local clone, which was then retired. Dependent
Personal/System release reviews and final installed production measurements
remain. Earlier diagnostic instances and scratch are retired; the release
operation used one isolated instance for the dependent reviews. That instance
has now stopped and joined; an external process audit found no remaining
references. Its ephemeral root, owned alias directory, and regenerable local
published-source clone are removed. Inherited shared caches remain intact.

The subsequent Personal 0.3.73 and System 0.3.99 publication reviews are complete
against upstreams `87cd767a679a4824fe095307cd69b78e67450195` and
`28f01934943c088141f4b1c480aa7fa221d40d57`, respectively. Their exact seven and
32 changed-path inventories, source bytes, and modes match checked commits
`0925929c200af16bf83c88027fea451dfa972dd3` and
`4fe21fe9e99dbf86af034c93a721304828dc7a73`. Both normal authoring setups resolved
the actual published Base commit, not its earlier development-source identity.
The user authorized both releases. Fresh normal authoring reviews reproduced
the exact approved content before publication, including byte-identical diffs.
Personal 0.3.73 is published at
`50789363f02e2ff442f7753d5e8c165196f81adf`; System 0.3.99 is published at
`25fa8a5e0fbea99f249754dea74dde987ce9b5a8`. The canonical release-pin generator
adopted all three real publication receipts together. Published Git tags were
fetched normally and admitted through the canonical source-cache boundary from
local Git, without retargeting original source branches. Final installed
production measurements remain required; publication is not a speedup claim.

The first post-publication dev diagnostic did not reach hosted-shell readiness:
the default shell was offered a workspace-code launch review. This is not a
valid automatic-UI latency sample. Investigation established that host-build
provenance and native activation consent are distinct decisions in current main:
the exact shell EV was host-admitted and its inventory vouched for the local
tree, while its activation approval store was absent. The explicit seeded-app
regression expects a prompt. Creation and native participants can share one
startup review; a creation packet containing the shell does not prove stale
code. No trust policy was changed. The failed diagnostic and two subsequent
owned investigations were stopped and joined; their private state was removed
after zero-process-reference audits. Shared caches and bounded evidence remain.
First-use actionable review, post-scripted-fixture-consent UI, and later
existing-state startup must be reported separately, never combined into an
automatic fresh-workspace readiness claim.

Package production now borrows the normal canonical content cache instead of
overriding its location with disposable scratch. Its workspace state, process
owner, and installed SDK boundary remain private/exact; cache hits are not
release proof. The subsequent verifier still owns an empty derived cache and
isolated environment. Thirty focused release tests pass, including actual child
environment checks for producer cache selection and verifier server/CLI
isolation, cancellation, identity mismatch rejection, and cleanup. The rejected
external cache-copy watcher was never run and is removed: the producer alone
owns and joins cache users before retirement.

The canonical production build and Linux x64 application package now pass using
all three published pins. Build contracts report 32 checks, four import smokes,
one executable smoke, and three native-runtime contracts. The genuine isolated
consumer reused all 111 exact runtime records (26 Base, 41 Personal, 44 System;
59 unique artifact keys). After its owners joined, the installed schema
component was published mode 0644 with 18 receipts; the canonical installed
reader admits all 18 against host fingerprint
`52a120a0a9ce3275986002c178c31b134246f90f93d9abcb5dbbc7393ff06846`.
The normal packaging wrapper consumed its after-pack completion witness and
retired its staging tree. No external cache-copy job or verifier-cache seeding
was used. This verifies release production and reuse, not launch latency.

Archive inventory inspection then found a packaging-boundary defect before
timing the installed app. The first resulting application occupied 13 GB;
its ASAR contained 10,335,872,742 packed bytes from archived host generations
alone. The runtime-script closure transform had converted each ordered string
pattern into an independent electron-builder FileSet, turning exclusions into
separate union members. Explicit exclusions therefore did not remove archived
host generations or source Node distributions. A separate source-package
projection also copied a nested development Electron installation. Root
dependency-store leakage was investigated but was not the cause: the actual
ASAR inventory contained no root `.pnpm` subtree. These are measured packaging
contents, not evidence of startup latency. The corrected transform preserves
the original string rules across both packaging passes and adds discovered
script dependencies to that same matcher. A mapped source-package projection
excludes nested development installs; the ordinary production collector still
owns dependency versions and destinations. Thirty-two focused cases pass,
including the real builder's matchers and linked-SDK copy logic, genuine nested
production dependencies, source/type exports, architecture exclusions, and
second-pass idempotence. The oversized diagnostic application was retired after
all archive readers joined and an independent process-reference audit passed;
its bounded inventory and original release proof remain. The corrected package
subsequently passed the normal complete release-consumer gate: all 111 exact
records reused in an isolated fresh installation and all 18 installed schema
receipts admitted against production fingerprint
`4b2456cf0b8c852d3b1256dca414e708d8db9fda488beece329b86fe98ee669f`.
Its ASAR is 38,984,448 bytes (57,725 files); the archive inventory contains none
of the forbidden historical, stock-Node, nested source-package npm, or
wrong-architecture paths. The whole unpacked application is approximately
2 GB. The dependency fingerprint legitimately changed with the corrected
installed dependency boundary; all release artifacts were produced and checked
against that actual new identity. No older receipt was substituted.

The first corrected-package latency attempt was interrupted by the host X
display disconnecting; it is not a valid latency sample. Its application joined
and private state was retired after an external zero-reference audit. Subsequent
attempts use an owned isolated virtual display/session, not the user's desktop.

An isolated-display run reached both semantic activations and a healthy restored
UI, then exposed an actual ordered-shutdown deadlock before a clean repeat.
Both workspace children exited successfully, but the hub had stopped listening
while retaining three accepted connections to Electron's network process.
`http.Server.close()` awaited those connections; Electron awaited the hub
before exiting. The diagnostic was explicitly cancelled and joined, its
private fixture removed, and the cancellation retained separately from the raw
helper output. That run is not passing shutdown or final comparison evidence.
The repair belongs to the gateway's connection owner: stop acceptance, retire
all owned HTTP and upgraded sockets, and join their actual close events before
releasing stores. No elapsed-time recovery policy is involved. The gateway now
has one idempotent close owner shared by ordinary shutdown and failed startup
acquisition cleanup. Seventy-two focused hub cases pass; the real streaming-HTTP
and upgraded-connection case verifies termination, client error propagation,
closed-listener refusal, and joined socket events. All four host typecheck
programs and the rebuilt production artifact/native contracts pass. The final
canonical package passed all 111 exact fresh-install runtime checks and admitted
all 18 schema receipts against production fingerprint
`64087b3cb4c77af3ea79fee62f1150bb2642cf5eb2c10837d76556130f718776`.
The installed dependency fingerprint is unchanged from the corrected package;
the actual host fingerprint changed with the gateway repair. Its ASAR is
38,984,963 bytes and retains the same clean packaging inventory boundary.

Two final unchanged-artifact comparisons used private empty initial state,
credentials and derived caches, then the same state for an immediate restart.
No unrelated heavy work overlapped the timed intervals. Both Personal and
System semantic activation receipts and the actual restored desktop layout are
required; a splash, listening server or rendered shell alone does not qualify.

| Boundary | First comparison | Exit-receipted repeat |
| --- | ---: | ---: |
| First-use actionable native review | 5.908 s | 5.884 s |
| Scripted Start to healthy restored UI | 2.952 s | 2.465 s |
| Existing-state process to healthy restored UI | 5.762 s | 5.651 s |

The first-use review was accepted only as an explicit scripted fixture action
through its ordinary DOM Start button. Its inspection/setup interval is
reported separately; these are not automatic first-use readiness claims.
The respective full first-use intervals were 9.076 s and 8.605 s, including
scripted consent and setup. Neither comparison needed a shutdown intervention.
The repeat also records both native application exits as code 0 with no signal;
its outer owner joined and independently audited zero fixture references.
Both private fixtures and the regenerable installed test package are retired;
bounded profiles, receipts and screenshots remain. Shared caches are preserved.
The old baseline had failed semantic activation and cannot establish a
before/after healthy-startup speedup percentage. Existing-state production
readiness now falls within the requested 5–10 second range on this host.

## Final developer measurement and remaining gap

The final `pnpm dev` comparison used the same clean configured local template
checkouts, one immutable development host generation, an isolated display and
profile, the inherited canonical shared cache, and two separately provisioned
fresh ephemeral instances. Both reused the same verified complete runtime
release; these are warm-content-cache measurements, not cold producers or
existing-workspace restarts. Each native Start was an explicit scripted fixture
action, reported separately from first actionable UI and healthy readiness.

| Boundary | First fresh workspace | Second fresh workspace |
| --- | ---: | ---: |
| Actionable native review | 10.156 s | 10.573 s |
| Start to healthy restored UI | 3.540 s | 3.821 s |
| Full interval, including scripted consent/setup | 13.864 s | 14.546 s |

Both Personal and System emitted successful semantic activation reports and the
desktop restored its real workspace layout. Both supervisors and inspector
connections joined; both ephemeral roots disappeared before completing their
samples. The outer owner audited zero remaining fixture references and removed
the private diagnostic profile, input aliases, local published-source clone and
temporary compiler caches. The inherited shared cache and committed source
worktrees remain intact.

Dev has **not** reached the requested 5–10 second target. The launcher's actual
phase reports attribute 2.882/3.231 s to input readiness, including approximately
1 s concurrent prerequisite/checkpoint work followed by 1.836/2.099 s preparing
workspace sources. Fresh semantic snapshot import takes 1.68–2.01 s per workspace;
the two workspace imports run independently and must not be added together.
Their source scan, source hash/blob-ingestion and CAS-tree mirror fields are
zero. Native startup reports a further 5.20/5.53 s server-spawn interval and
3.40/3.68 s desktop mount interval. These nested phase reports are attribution,
not additive independent savings estimates. The remaining work is launcher
source preparation and fresh semantic/UI initialization, not missing runtime
build-cache reuse. Retaining workspace state to disguise that cost is not an
acceptable optimization.

Private bounded logs, profiles, and retirement receipts are retained outside the
repository under the operation's performance evidence directory. They are not
release artifacts or a reason to retain workspace databases and dependency trees.
