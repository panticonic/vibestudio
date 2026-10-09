/**
 * Template resolution — determines framework and HTML shell for panel builds.
 *
 * Resolves both concerns in one pass from materialized source state:
 * - htmlPath: which HTML shell to use (panel's own, template's, or null for adapter fallback)
 * - framework: which compiler adapter to use ("react", "svelte", "vanilla", etc.)
 */

import * as fs from "fs";
import * as path from "path";
import { detectFrameworkFromDependencies } from "./platformModules.js";

export interface TemplateConfig {
  framework?: string;
}

export interface ResolvedTemplate {
  /** Path to the template index.html, or null if adapter should generate fallback */
  htmlPath: string | null;
  /** Resolved framework ID */
  framework: string;
}

/**
 * Resolve template HTML and framework for a panel from materialized source.
 *
 * HTML resolution: panel index.html → named template → default template → null
 * Framework resolution: template config → dep auto-detection → "vanilla"
 *
 * A panel with its own index.html is self-contained — the default template's
 * framework does not bleed in. Only an explicit template reference or dep
 * auto-detection determines the framework.
 *
 * An explicit `vibestudio.template` must name an existing template; a missing
 * template or an unreadable `template.json` is a build error, never a silent
 * fallback to another shell or framework.
 */
export function resolveTemplate(
  manifest: { template?: string },
  dependencies: Record<string, string>,
  panelSourcePath: string,
  sourceRoot: string
): ResolvedTemplate {
  // Panel has its own index.html — self-contained
  const panelHtml = path.join(panelSourcePath, "index.html");
  if (fs.existsSync(panelHtml)) {
    // Only use template framework if explicitly referenced
    const templateFramework = manifest.template
      ? readTemplateFramework(sourceRoot, requireTemplateDir(sourceRoot, manifest.template))
      : null;
    return {
      htmlPath: panelHtml,
      framework: templateFramework ?? detectFrameworkFromDeps(dependencies),
    };
  }

  // Explicit template reference
  if (manifest.template) {
    const templateDir = requireTemplateDir(sourceRoot, manifest.template);
    const htmlPath = findHtml(templateDir);
    if (!htmlPath) {
      throw new Error(
        `Panel template "${manifest.template}" has no index.html (expected ${path.join(templateDir, "index.html")})`
      );
    }
    return {
      htmlPath,
      framework:
        readTemplateFramework(sourceRoot, templateDir) ?? detectFrameworkFromDeps(dependencies),
    };
  }

  // Implicit default template
  const defaultDir = path.join(sourceRoot, "templates", "default");
  const defaultHtml = findHtml(defaultDir);
  if (defaultHtml) {
    return {
      htmlPath: defaultHtml,
      framework:
        readTemplateFramework(sourceRoot, defaultDir) ?? detectFrameworkFromDeps(dependencies),
    };
  }

  // No template at all — vanilla fallback
  return {
    htmlPath: null,
    framework: detectFrameworkFromDeps(dependencies),
  };
}

function findHtml(templateDir: string): string | null {
  const htmlPath = path.join(templateDir, "index.html");
  return fs.existsSync(htmlPath) ? htmlPath : null;
}

function requireTemplateDir(sourceRoot: string, templateName: string): string {
  const templateDir = path.join(sourceRoot, "templates", templateName);
  if (!fs.existsSync(templateDir)) {
    throw new Error(`Panel declares template "${templateName}", but ${templateDir} does not exist`);
  }
  return templateDir;
}

function readTemplateFramework(sourceRoot: string, templateDir: string): string | null {
  const configPath = path.join(templateDir, "template.json");
  if (!fs.existsSync(configPath)) return null;
  let config: TemplateConfig;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as TemplateConfig;
  } catch (error) {
    throw new Error(
      `Template config ${path.relative(sourceRoot, configPath)} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return config.framework ?? null;
}

function detectFrameworkFromDeps(dependencies: Record<string, string>): string {
  // The framework ↔ dependency mapping is the platform-module contract
  // declared in platformModules.FRAMEWORK_MODULES.
  return detectFrameworkFromDependencies(dependencies) ?? "vanilla";
}
