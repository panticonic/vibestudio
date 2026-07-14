# Gad repository reducer kernel

This isolated package is the portable first Gad repository reducer slice. It depends only on the
frozen Gad repository contract, portable VCS cores, and transport-neutral exact content refs.

The kernel accepts typed immutable repository/working inputs, creates typed immutable outputs, and
returns a publication request as data. Its host adapter has exact object, immutable database
finalization, and exact-hash history/merge operations; it deliberately has no mutable ref API.

Implemented here are frozen fixture import, edit-without-user-commit, selected commits with residual
working state, deterministic external-object extraction and Vibe worktree projection, sequential
exact-hash merges, portable text conflict resolution/provenance, and post-finalization artifact
templates. The package does not integrate the native workerd API, mutate protected refs, migrate the
monolithic Gad host, or claim native blame parity.
