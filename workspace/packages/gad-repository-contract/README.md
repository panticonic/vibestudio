# Gad repository contract

This source-only package owns the portable v1 application contract for the
first per-context, Dolt-backed Gad repository. It intentionally has no host,
workerd, mutable-ref, or publication dependency.

The contract freezes:

- caller-minted stable file, edit, hunk, and commit-intent identities;
- the small mergeable repository schema and its complete list of external
  blob/hunk reference columns;
- the distinction between physical working snapshots and deliberate
  user-visible commit intents;
- canonical repository, working-snapshot, and context artifact templates;
- a trusted full-row external-reference extractor; and
- the authoritative-file-row projector that delegates to Vibe's existing
  canonical Blob/Tree codec.

The package does not implement reducer invocation, native history operations,
merge resolution, protected publication, or migration of the monolithic Gad
store. Those remain later vertical slices over this boundary.
