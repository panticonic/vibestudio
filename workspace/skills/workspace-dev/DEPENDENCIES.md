# External dependency resolution

Buildable workspace units are not pnpm importers. Declare ordinary registry
dependencies in the unit's `dependencies`; declare resolution policy under
`vibestudio.dependencyResolution`. Build V2 reads both from the exact
materialized source being built. It never inherits root package-manager policy.

## Contents

- [Declare dependencies](#declare-dependencies)
- [Override a resolution](#override-a-resolution)
- [Patch an exact dependency](#patch-an-exact-dependency)
- [Own a patched integration](#own-a-patched-integration)
- [Understand the live build behavior](#understand-the-live-build-behavior)
- [Diagnose and verify](#diagnose-and-verify)

## Declare dependencies

Put every direct external import in `dependencies` with a registry version:

```json
{
  "dependencies": {
    "upstream-package": "1.2.3"
  }
}
```

Use `workspace:*` for internal workspace packages. Do not add a buildable unit
to `pnpm-workspace.yaml`, the checkout lockfile, or the host's dependencies.
Build V2 installs the external closure into a content-addressed derived
environment when it builds a consumer.

## Override a resolution

Put dependency pins in the unit that owns the integration:

```json
{
  "vibestudio": {
    "dependencyResolution": {
      "overrides": {
        "transitive-package": "4.5.6",
        "ws@8": "8.21.1"
      }
    }
  }
}
```

Override keys may name a package or one package major. Values must be registry
versions accepted by Build V2. A direct-dependency override changes that direct
install request; a transitive override becomes npm resolution policy in the
derived install. Overrides propagate through the internal workspace dependency
closure. Conflicting values for one selector fail the build.

Do not use top-level `overrides`, `resolutions`, `pnpm.overrides`, or
`pnpm.patchedDependencies` in a buildable unit. Those are package-manager
importer policy and have no live workspace-build semantics.

## Patch an exact dependency

Declare a unified text diff beside its owner:

```json
{
  "dependencies": {
    "upstream-package": "1.2.3"
  },
  "vibestudio": {
    "dependencyResolution": {
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

The selector must be an exact registry `package@version`, including the scope
for scoped packages. Ranges are invalid. `path` is relative to the declaring
unit and must remain inside it. Patch paths may use the conventional `a/` and
`b/` prefixes; absolute paths, `..`, and symlink traversal are rejected.

`roots` names one or more of the owner's direct external dependencies whose
installed closures carry the target:

- For a direct patch, name the target itself.
- For a transitive patch, name the direct parent dependency.
- If several direct dependencies can carry the same exact target, name each
  relevant root.

For example, patch `transitive-package` reached through `parent-package` like
this:

```json
{
  "dependencies": {
    "parent-package": "7.0.0"
  },
  "vibestudio": {
    "dependencyResolution": {
      "patches": {
        "transitive-package@4.5.6": {
          "path": "patches/transitive-package@4.5.6.patch",
          "roots": ["parent-package"]
        }
      }
    }
  }
}
```

Every root must be that owner's direct external dependency. `roots` selects
whether a patch belongs in a derived dependency subset; it is not another
dependency request and does not make a missing target optional.

## Own a patched integration

Give a patched external one canonical workspace owner, normally an adapter
under `packages/`:

1. Put the upstream dependency, overrides, patch file, and patch declaration in
   the adapter.
2. Export the API the workspace needs from the adapter.
3. Make consumers depend on and import the adapter, not the patched upstream
   package.

Within one internal dependency closure, another unit may not directly depend
on or override the patched package. Two owners may not declare the same exact
patch selector. These checks make the workspace import name the explicit
identity of the patched integration instead of silently changing an upstream
import. See `packages/pi-ai/package.json` for a live direct-patch example.

Use an adapter even when the target is transitive: the owner depends on the
direct parent named in `roots`, carries the policy, and exposes the stable
workspace-facing API. Do not teach the host, root installer, or an unrelated
consumer about that userland dependency.

## Understand the live build behavior

For each build, Build V2:

1. Collects policies and patch bytes from the exact internal source closure.
2. Installs the derived registry dependency environment.
3. Applies each patch to every installed package whose name and version exactly
   match the selector, including hoisted and nested copies.
4. Seals dependency versions, overrides, patch roots, and patch-content digests
   into the cache key and build recipe.
5. Records the digest of every patched or deleted file and rejects a modified
   or incomplete cache receipt.

Patch application is strict. The build fails for an absent patch file, unsafe
path, duplicate owner, conflicting override, missing declared root, selector
that matches no installed package, empty patch, or hunk that does not apply.
Patches are unified text diffs applied after dependency installation; they do
not modify install-script behavior and are not a binary-patching mechanism.

Extensions can produce a smaller runtime dependency install after bundling. A
patch enters that install only when at least one declared root remains
external. Once selected, the patch is still mandatory and must match. A patch
whose roots were bundled stays out of the runtime install while still affecting
the build environment. Runtime dependency caches and sealed recipes preserve
the same patch inputs for reconstruction after eviction.

## Diagnose and verify

Run an exact Build V2 report for the consuming unit. A root `pnpm install` does
not exercise userland patching and is not evidence that the patch works.

From a Vibestudio source checkout, run the relevant focused tests plus:

```sh
pnpm check:package-dependencies
pnpm check:userland-package-manager-boundary
pnpm type-check:userland
```

The boundary check rejects userland package-manager policy, host dependencies
on userland units, and root patches reaching into `workspace/`. When updating
an upstream version, update its direct dependency, exact patch selector, and
patch contents together, then rebuild the real consumer. A no-longer-applicable
patch must fail visibly; never retain it through a best-effort or once-only
installation path.
