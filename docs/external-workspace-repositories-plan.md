# External workspace repositories

Status: superseded by the userland template and Git architecture

## Decision

The earlier version of this plan put external-repository acquisition,
credentials, consent, retry state, and promotion into a host-owned workspace
seed lifecycle. That architecture has been removed.

The boundary is now deliberately small:

- Before userland starts, the host may initialize a workspace from one complete
  immutable root-template pin: normalized URL, canonical ref, exact commit, and
  canonical `v1-sha256` snapshot digest.
- The host verifies and imports exactly that root. It does not discover a URL,
  resolve a moving ref for the caller, present product-specific preview or
  consent UX, or interpret nested repository declarations.
- After bootstrap, external repositories are ordinary userland behavior.
  Template composition uses the template-composer extension; Git acquisition
  and synchronization use the Git bridge and generic credential/Git
  primitives; semantic changes use the ordinary candidate, review,
  integration, commit, and protected-main publication flow.
- Operational Git checkouts remain interchange state, never workspace source or
  build input.

## Removed contract

`git.upstreams.<section>.<name>.seed`, `WorkspaceSeedAcquirer`, its durable
journal/readiness state, hub initialization approval/retry methods, hub
template inspection, workspace-specific Git credential binding methods, and the
`workspace pin-seed` maintainer command are not part of the architecture.
Upstreams describe ongoing tracking only.

## Reproducibility and provenance

Userland acquisition still freezes and verifies immutable coordinates before
import. Each imported repository enters the semantic system as an exact
external snapshot and produces an unpublished candidate. The caller explicitly
reviews and integrates that candidate. Template state retains source coordinates
and subtree digests for reproducible composition.

The sole initialization exception is the exact root pin supplied at workspace
creation. It exists only to bootstrap enough trusted userland to perform every
other operation itself.

## Acceptance

The deterministic full-stack test uses a local smart-HTTP Git server and the
public CLI to exercise both sides of the boundary:

1. create a workspace from a caller-supplied exact root pin through the normal
   hub and semantic initialization path;
2. approve the normal userland extensions;
3. inspect, add, update, suggest, and remove templates through the userland
   composer;
4. import, observe, push, and pull ordinary repositories through the Git bridge;
5. verify semantic review, protected-main publication, and remote contents.

No disposable-remote shortcut or host seed path is permitted in that exercise.
