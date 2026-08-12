# Build V2 dependency resolution

Buildable workspace units are not pnpm importers. External dependency policy
therefore belongs to Build V2 and is declared in the unit's `vibestudio` block:

```json
{
  "name": "@workspace/example-adapter",
  "dependencies": {
    "upstream-package": "1.2.3"
  },
  "vibestudio": {
    "dependencyResolution": {
      "overrides": {
        "transitive-package": "4.5.6"
      },
      "patches": {
        "upstream-package@1.2.3": {
          "path": "patches/upstream-package@1.2.3.patch",
          "roots": ["upstream-package"]
        }
      }
    }
  }
}
```

Patch selectors use an exact registry `package@version` identity. `path` is
relative to the declaring unit and must remain inside it. `roots` names the
owner's direct external dependencies whose installed closures contain the
target. For a direct patch, the root is normally the target itself; for a
transitive patch, it is the direct parent dependency. Patch files use unified
diff format.

The declaring workspace package owns the policy. Consumers opt into it by
depending on and importing that package. A consumer in the same internal
dependency closure may not also depend directly on, or override, the patched
external package; the owner should expose any API that consumers need. This
makes a workspace import name the explicit identity for the patched integration
instead of silently changing an upstream import.

The target may be direct or transitive. After Build V2 installs the complete
registry dependency closure, it applies the patch to every installed package
whose name and version exactly match the selector, including nested copies. A
selector that matches nothing, a conflicting owner or override, an unsafe path,
or a failed hunk aborts the build.

When Build V2 derives a smaller environment—an extension runtime dependency
subset, for example—it carries a patch only when at least one of its declared
roots is present. A carried patch remains mandatory and must match. This keeps a
patch for a bundled dependency out of the runtime install without making a
missing transitive patch silently optional.

Dependency versions, Build V2 overrides, and patch digests form the derived
dependency-cache key. The cache receipt records every patched file's final
digest, so an incomplete or modified cache is rebuilt. Extension runtime
dependency caches use the same policy and preserve the exact patch inputs in
their sealed build recipe so they can be reconstructed after eviction.

Root `package.json` overrides and patches are host installation policy and are
never inherited by workspace builds. The package-manager boundary check rejects
root patches that reach into `workspace/` and rejects package-manager resolution
fields on buildable workspace units.
