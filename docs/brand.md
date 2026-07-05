# Vibestudio Brand Assets

Vibestudio uses a single monochrome palm/tree mark with light and dark source tiles.
Do not hand-edit generated output files unless you are testing locally and plan
to regenerate the suite afterward.

## Canonical Sources

- `build-resources/brand/source/vibestudio-light.png`
- `build-resources/brand/source/vibestudio-dark.png`

These cropped PNGs are the canonical raster sources. Generated output is written
to desktop, web, workspace, mobile host, Android, and iOS asset locations.

## Regeneration

Prerequisites:

- ImageMagick `convert`
- Optional `pngquant` for smaller PNGs

Regenerate all branded assets:

```bash
pnpm generate:brand-assets
```

Crop new source art and replace the canonical source files:

```bash
pnpm generate:brand-assets -- --light /path/to/light.png --dark /path/to/dark.png --update-source
```

Generated surfaces include:

- `build-resources/icon.icns`
- `build-resources/icon.ico`
- `build-resources/dmg-background.png`
- `build-resources/brand/favicon-*`
- `build-resources/brand/vibestudio-mark*.svg`
- `workspace/packages/brand-assets/src/*`
- `workspace/apps/mobile/src/assets/*`
- `apps/mobile/assets/*`
- `apps/mobile/android/app/src/main/res/mipmap-*`
- `apps/mobile/android/app/src/main/res/drawable/launch_screen.xml`
- `apps/mobile/ios/Vibestudio/Images.xcassets/AppIcon.appiconset`
- `apps/mobile/ios/Vibestudio/Images.xcassets/LaunchLogo.imageset`

## Usage Rules

Use the shared components instead of importing PNGs directly in product UI:

- Web/workspace UI: `VibestudioLogo` from `@workspace/ui`
- Workspace mobile app: `VibestudioLogo` from `workspace/apps/mobile/src/components/VibestudioLogo`
- Shipped native host fallback: `VibestudioLogo` from `apps/mobile/VibestudioLogo.js`

The web component imports assets from the declared `@workspace/brand-assets`
package. Do not add filesystem escapes such as `../../../assets/...` to
`@workspace/ui`; panel build materialization checks out packages through their
declared dependency graph.

Prefer `variant="tile"` for onboarding, splash-adjacent, and prominent brand
surfaces. Prefer `variant="mark"` for title bars, empty states, loading states,
and compact chrome.

The SVG mark files are hand-authored fallbacks for vector/favicon contexts. The
cropped PNG source tiles remain canonical for generated packaging assets.

Brand color direction:

- Primary surfaces are neutral ink/slate.
- The default app accent is amber.
- Avoid new purple/blue gradients for app chrome.
- Panel-local syntax colors, agent colors, and user-lane colors may use their
  own semantic palettes when they are not acting as brand chrome.
