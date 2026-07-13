# `@vibestudio/git`

This package owns the external Git transport boundary: cloning, fetching, and
pushing ordinary Git repositories for extensions and host adapters. It is kept
separate because it is consumed from both the host dependency graph and
workspace extension builds.

Vibestudio's internal GAD/VCS service contract is a different concern. Its wire
schemas and presentation helpers live under `@vibestudio/service-schemas/vcs`
and `@vibestudio/shared/vcsFormatting`; they do not depend on Git repositories.
