# Gad repository reducer kernel

This isolated package is the portable first Gad repository reducer slice. It depends only on the
frozen Gad repository contract, portable VCS cores, and transport-neutral exact content refs.

The kernel accepts typed immutable repository/working inputs, creates typed immutable outputs, and
returns a publication request as data. Its host adapter has exact object, immutable database
finalization, and exact-hash history/merge operations; it deliberately has no mutable ref API.

Implemented here are frozen fixture import, edit-without-user-commit, selected commits with residual
working state, deterministic external-object extraction and Vibe worktree projection, sequential
exact-hash merges, portable text conflict resolution/provenance, and post-finalization artifact
templates.

The package also contains the first deployable Worker/client boundary. A bundle supplies an
invocation-local adapter and exports the object returned by
`createGadRepositoryReducerWorkerModule()`. Its modules-syntax handler accepts the current workerd
`reduce(databases, input, env, ctx)` event, while the typed three-argument core keeps `env` outside
the portable kernel. It validates the complete named input/private-output handle set, runs the real
portable kernel, preserves caller-declared sequential merge order, and returns only selected
database handles plus canonical application bytes. Final repository roots and commit identities are
read from workerd's selected-database result rather than guessed inside the Worker. Repository and
working manifest templates use the existing exact Gad codecs.

`GadWorkerdHostClientV1` supplies a typed deterministic run/follow seam. It validates each
application exact ref against the full transport database ref, reconciles ambiguous runs by one
execution key, reconstructs exact Gad output refs from the native result, and creates a separate
publication intent. Neither the Worker context nor the portable host adapter has a mutable-ref or
publication method.

The in-memory shadow fixture executes the real module object and portable kernel through this
boundary, including two sequential immutable merges, ambiguous-run follow, exact result decoding,
and separate publication. The transport fixture now uses the runtime's actual Dolt repository-root
identity (`dolt-blake3-160` with the typed Dolt root codec), rather than the earlier SHA-256 shadow
placeholder.

`workerd-binary.integration.test.ts` supplements that shadow proof with an opt-in executable
configuration for the local workerd fork. It bundles the real Worker adapter and Gad import kernel,
starts a standard-profile `reducerWorker` behind a `databaseReducer` binding and
`databaseReducerLocal`, uses `ctx.cas` for exact projection/image objects, mutates and commits a
real invocation-private Dolt output, and decodes the native selected database through
`GadWorkerdHostClientV1`. Run it with:

```sh
WORKERD_DATABASE_REDUCER_BIN=/absolute/path/to/workerd \
  pnpm --dir workspace vitest run --root .. --config vitest.userland.config.ts \
  workspace/packages/gad-repository-reducer/src/workerd-binary.integration.test.ts
```

The test is skipped unless the variable names an existing binary, so the ordinary userland suite
does not silently substitute the published stock workerd. The bundled adapter is deliberately an
import-only fixture, not the production Gad database adapter. It does not prove persisted image
reload, sequential native merge/conflict tables, blame, publication, monolithic-host migration, or
production cutover.
