# External snapshot import

## Import one exact snapshot

Use `vcs.importSnapshot` when Git, an archive, upload, filesystem tree, or
generated source enters semantic history. One import creates one ordinary work
unit with `kind: "import"` and one committed event over exact complete
repository trees. The work unit requires one `externalSnapshot` value. Its
repository and file differences are ordinary changes: repository create, file
create/delete/mode, and whole-content replacement. There is no synthetic
barrier change or second import graph.

Provide exactly the external-source coordinate that can be proved:

- source kind and canonical credential-free URI;
- exact snapshot revision;
- complete repository trees with each file's canonical path, exact content
  hash, and mode.

The host content owner verifies the named CAS digests and returns their
intrinsic content descriptors without transporting the blobs into semantic
execution. Callers do not assert content kind, byte length, or coordinate
extent. The semantic workspace validates the host receipt, enriches every file
fact with its observed intrinsic descriptor, then derives one
canonical `snapshotDigest` from the complete normalized repository/file
facts; callers do not supply a root, tree hash, or snapshot digest. The
work unit stores all four values together:
`sourceKind`, `sourceUri`, `snapshotRevision`, and `snapshotDigest`. They answer
which source snapshot the importer observed and which verified descriptors
crossed the boundary, at snapshot granularity. The source coordinate is
source-observed evidence—not cryptographic identity, authorization, or native
authorship—and does not assert who authored any path or coordinate before
import. Never place a checkout path, embedded credentials, access token, or
signed query parameters in the stored source URI. For Git, use the canonical credential-free remote; a
local-only remote is represented by an opaque digest, not its machine path.

The normalized snapshot also stores the complete sorted IDs of every repository
the snapshot targeted, including an identical re-import that authors no content
change. Work-unit inspection returns that exact `targetRepositoryIds` vector;
the import descriptor budget makes a count/preview pair unnecessary.
`imports-repository` neighbors expose the same relation as typed walkable edges.
Do not infer targets from authored-change previews, which are independently
bounded and may be empty.

Capture/read the external source through the ordinary `fs` owner so its exact
content digests are present in the workspace CAS. `vcs.importSnapshot` consumes
the complete source-level repository/file facts; it does not accept intrinsic
content claims, a caller root, a raw host path, or perform a hidden filesystem
read.

One import is deliberately small enough for one atomic semantic transaction:
the complete canonical serialized request descriptor is at most 512 KiB, each
path component is at most 255 UTF-8 bytes, and each complete file path is at
most 512 UTF-8 bytes. Repository and file counts have no second arbitrary cap;
every item already consumes the one descriptor budget. Repositories and files
must arrive in strict canonical path order. When replacing repositories, their
exact existing basis consumes the same budget, so a small request cannot trigger
an unbounded deletion plan. There is no upload session, chunk assembler, or
partial import state. A larger descriptor or replacement basis is refused.

Every path crosses one shared admission predicate at schema ingress, semantic
resume, external adapters, host scans, and materialization. `.git`, `.gad`, the
materializer's context-binding file, and exact credential-bearing filenames
such as `.env` and `.npmrc` cannot enter semantic state: common project tools
consume those exact names automatically, so materializing them can disclose
credentials or alter host builds. Templates such as `.env.example` remain
ordinary source. Ordinary project content such as `dist/`, `out/`,
`release/`, `coverage/`, `.cache/`, `node_modules/`, logs, archives, and
environment templates is not excluded merely by convention.

There is no evidence-quality mode, per-path last-touch data, imported author,
external commit graph, or evidence mini-graph. Do not traverse Git history to
make the import look more complete. A shallow clone is sufficient when it can
identify the requested revision and exact tree. If a separate Git query says a
commit last touched a path, describe that as external path-level evidence; do
not turn it into Vibestudio line blame. The current import contract deliberately
does not persist that optional claim. Blame stops at an import boundary when
its terminal ordinary change belongs to an import work unit.

Content classification is exact and source-independent. Decode the complete
blob as strict UTF-8. A successful decode produces text with `byteLength` equal
to the original octet count and `coordinateExtent` equal to the decoded UTF-16
code-unit length. Any malformed sequence produces opaque bytes with equal byte
length and coordinate extent. File extension, MIME type, NUL heuristics,
replacement decoding, and caller overrides do not participate.

## Prepare causal ingress and state

When an agent imports, run it from the real tool invocation so the graph remains
trigger message → turn → invocation → globally unique semantic command → import
work unit → ordinary changes. An authorized direct import instead stops
honestly at its semantic command. Do not create a wrapper agent or synthetic
adapter invocation.

Import requires a clean context because it creates a committed import event
directly. Commit or discard local applications first. Supply the current
working head and one globally unique command ID with the source tuple and
complete repository/file source facts. The semantic workspace observes each
distinct content digest through the existing content port, validates its
intrinsic descriptor, and derives the snapshot digest only from the normalized
combination. Raw blob bytes do not cross
into semantic execution.

For a new repository, omit its repository ID and provide a vacant workspace
path. For a later complete snapshot of an existing repository, provide its
stable repository ID. The imported manifest is complete, not a patch. The
semantic workspace derives only the changes between that complete snapshot and
the exact basis. Unchanged files do not get fake changes.

A whole-content external replacement records exact before and after endpoints
but no inferred preservation mapping. Similar bytes do not prove coordinate
continuity. Because import changes use the ordinary vocabulary, they appear in
normal compare pages, can be integrated in small local steps, and can be
reverted without an import-specific workflow.

## Verify the result

Inspect the returned event and import work unit. Confirm that the work unit's
`externalSnapshot` exposes `sourceKind`, `sourceUri`, `snapshotRevision`, and
`snapshotDigest` together, plus the complete sorted `targetRepositoryIds`
vector. The `imports-repository` neighbors expose those same exact targets as
walkable edges.
Inspect its ordinary authored changes and confirm the repository identities and
imported file states. Confirm each placed file reports intrinsic `contentKind`,
`byteLength`, and `coordinateExtent`.

For a vague question such as “who changed this line, and what do we actually
know?”, first run bounded blame. Walk native mappings normally. When a span
stops at an import boundary, inspect its terminal `changeId`, then the owning
`workUnitId`, then its command and causal ingress. Report the work unit's four
snapshot fields and its exact recorded intent summary, plus any later native
intent the graph actually proves. Join the change to its work unit through the
change's exact ownership field; never depend on membership in a bounded
authored-change preview. Say
explicitly that pre-import coordinate authorship is unknown. The importer may
have caused the admission command; that does not make it the author of the
external bytes. Do not attribute the line to the external revision's committer
or source system either.

Retry an identical uncertain import with the same command ID. Any change to the
source tuple, repository/file facts, or expected working head requires a
new globally unique command ID.
