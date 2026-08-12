# Build V2 dependency resolution

The canonical authoring contract now lives in the workspace development skill:
[external dependency resolution](../workspace/skills/workspace-dev/DEPENDENCIES.md).
It documents overrides, direct and transitive patches, owner adapters, derived
extension installs, cache and recipe identity, strict failures, and validation.

This placement is intentional: dependency resolution is a live userland Build
V2 capability, not root package-manager or host installer policy.
