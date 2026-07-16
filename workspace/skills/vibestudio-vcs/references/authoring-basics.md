# Managed authoring

## Discover identities before changing them

Call `vcs.status` and retain its exact `workingHead`. Resolve a known workspace
repository path at that state with `vcs.resolveRepository`; a `null` result
means the repository is absent there. Then use `vcs.listFiles` with the returned
stable `repositoryId`. Do not scan all state neighbors merely to turn one known
path into its identity. A file listing supplies stable `repositoryId`, `fileId`,
path, content digest, mode, `contentKind`, `byteLength`, and
`coordinateExtent`.

Read a managed file with `vcs.readFile` at the same state. Prefer a stable file
ID after discovery; use a path only to resolve the initial identity. A `null`
result means the file is absent at that exact state. This method is
semantic-only: always pass `state`, `repositoryId`, and a typed file selector.
Use `fs` to read a host or materialized path. Do not look for a raw VCS variant
or expect VCS to fall back to disk.

## Author one coherent local step

Use focused `write` and `edit` tools for ordinary text work. They compile to
the same semantic edit operation. Use `vcs.edit` when batching exact text,
binary, repository creation, file creation, delete, or mode changes matters.

The in-agent authoring tools supply the exact current tool invocation as causal
ingress. A linked agent credential without that parent may perform the
discovery and reads above but cannot author this step. An authorized paired or
direct human CLI may mutate without an agent parent; its causal walk ends
honestly at the admitted command. Do not create an adapter invocation merely
to make direct work appear agent-authored.

For a direct causally bound service request, supply:

- the current context ID;
- the exact expected working head;
- one globally unique command ID;
- one or more changes over stable repository/file identities;
- an optional concise intent summary.

Treat one edit request as one work unit and one local application. Keep the
returned `workingHead`, `workUnitId`, `applicationId`, and `changeIds` when the
task needs later inspection, revert, or explanation.

Text edit offsets are UTF-16 coordinates over the exact text read from the same
basis. The placed file state owns that coordinate domain:

- text has `contentKind: "text"`, byte storage length in `byteLength`, and
  UTF-16 code-unit length in `coordinateExtent`;
- opaque bytes have `contentKind: "bytes"` and equal `byteLength` and
  `coordinateExtent`.

Re-read before computing offsets after another mutation. Do not send a
coordinate-kind hint or infer text length from byte length; the service derives
the unit from the exact state and validates every range against its extent.

## Keep semantics explicit

- Create a repository with one `repository-create` change containing its
  complete initial file set. The repository identity and files are authored in
  one lifecycle work unit; do not `mkdir` a managed path or loop over writes to
  synthesize the lifecycle.
- Create a file with a destination repository and vacant path.
- Delete or change mode by stable file identity.
- Use `vcs.move` for a location change and `vcs.copy` for a new identity with
  source lineage; do not encode either as delete-plus-create.
- Use `vcs.importSnapshot` when content crosses an external provenance
  boundary. It authors ordinary changes under one import work unit.

## Continue or recover

After success, continue from the returned working head. On `RevisionChanged`,
call `status`, re-read the relevant files, and re-plan. Retry an identical lost
request with the same command ID; use a new command ID for any changed payload.

Consult the generated [public contract](public-contract.md) or live `help`
before constructing a direct service request. Do not infer fields from these
examples.
