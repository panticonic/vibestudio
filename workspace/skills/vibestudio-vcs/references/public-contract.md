<!-- GENERATED FILE — run: pnpm generate:vcs-skill-release -->

# Public VCS contract

This is a portable projection of `packages/service-schemas/src/vcs.ts`. The service schema is
the only wire-contract authority; the skill explains how to use it. Exact
request and response JSON Schemas are in
[public-contract.json](public-contract.json).

State is named only by committed events and local work applications. Every
mutation except `push` advances an exact context working head; `commit` and
`discard` consume the complete local application chain.

## Methods

| Method | Class | Purpose | Typed errors |
| --- | --- | --- | --- |
| `vcs.edit` | `context-write` | Atomically create repositories with their initial files or author exact text, binary, file-create, delete, and mode changes on the working head. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `DestinationOccupied` |
| `vcs.move` | `context-write` | Move stable file or repository identities without reconstructing intent from bytes. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `DestinationOccupied` |
| `vcs.copy` | `context-write` | Copy exact source files into new identities with immediate coordinate provenance. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `DestinationOccupied` |
| `vcs.integrate` | `context-write` | Take one local adopt, reconcile, or decline step against an exact source event. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `ConflictPresent`, `DependencyBlocked` |
| `vcs.revert` | `context-write` | Author explicit counteractions of exact semantic changes. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `ConflictPresent`, `DependencyBlocked` |
| `vcs.commit` | `context-write` | Commit the complete local application chain; derive its unique integration parent from recorded decisions, or accept an explicit zero-change source. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `IntegrationIncomplete` |
| `vcs.discard` | `context-write` | Discard the complete uncommitted chain and return to the committed event. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.importSnapshot` | `context-write` | Import one exact complete external snapshot as ordinary changes on an import work unit. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `DestinationOccupied`, `WorkingChangesPresent`, `ExternalEffectFailed` |
| `vcs.push` | `workspace-write` | Publish one exact already-committed event to protected main. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `WorkingChangesPresent`, `CommandIdReuse`, `ExternalEffectFailed`, `IntegrityFailure` |
| `vcs.status` | `read` | Return context pointers, clean state, main relation, and compact working counts. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.compare` | `read` | Compare an exact target state with a committed source event by semantic change. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.inspect` | `read` | Inspect one typed semantic node and a bounded preview of its direct adjacency. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.neighbors` | `read` | Page immediate typed provenance edges without persisting traversal state. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.history` | `read` | Page event history in either direction or past file history from one exact state. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.blame` | `read` | Trace an exact bounded file range through immediate content-coordinate mappings. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.resolveRepository` | `read` | Resolve one canonical repository path at one exact semantic state. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.readFile` | `read` | Read one file from an exact semantic state. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure`, `ExternalEffectFailed` |
| `vcs.listFiles` | `read` | Page the exact path-to-file manifest of one repository at one semantic state. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |

## Typed error codes

- `CommandIdReuse`
- `ConflictPresent`
- `DependencyBlocked`
- `DestinationOccupied`
- `ExternalEffectFailed`
- `IntegrationIncomplete`
- `IntegrityFailure`
- `InvalidReference`
- `NoEffect`
- `RevisionChanged`
- `ScopeTooLarge`
- `Unauthorized`
- `WorkingChangesPresent`

Mutation `commandId` values are idempotency identities, not actor or
authorship credentials. Retry the same ID only with an identical request.
Provenance is walked through typed nodes with `inspect`, `neighbors`,
`history`, and `blame`.
