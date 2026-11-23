#!/usr/bin/env node
/** Audit static and emitted utility imports against the real workspace package contracts. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import configuration from '../src/dev/developmentTemplateConfig.cjs';
const { resolveExportSubpath } = await tsImport('../packages/typecheck/src/lib/workspace-packages.ts', import.meta.url);
const { analyzeModuleImports, moduleCoordinate } = await tsImport('../packages/module-imports/src/index.ts', import.meta.url);
const { BUILDABLE_UNIT_DIRS } = await tsImport('../packages/workspace-contracts/src/sourceDirs.ts', import.meta.url);
const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.cache']);

export function workspaceReferences(text, file) {
  const references = analyzeModuleImports(text, file);
  // A worker can emit a utility's module source in a template string. Those imports
  // are resolved only when that utility runs; ordinary worker compilation misses them.
  for (const match of text.matchAll(/\b(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](@workspace(?:-skills|-workers|-panels|-clients|-about|-extensions)?\/[^"'\s]+)["']/g)) {
    const prefix = text.slice(text.lastIndexOf('\n', match.index) + 1, match.index).trimStart();
    if (prefix.startsWith('//') || prefix.startsWith('*') || references.some(ref => ref.specifier === match[1])) continue;
    references.push({ specifier: match[1], kind: 'value', line: text.slice(0, match.index).split('\n').length, generated: true });
  }
  return references;
}

function sourceTarget(directory, target) {
  const file = path.resolve(directory, target);
  const candidates = [file, ...(/\.[cm]?js$/.test(file) ? [file.replace(/\.[cm]?js$/, '.ts'), file.replace(/\.[cm]?js$/, '.tsx')] : [])];
  return candidates.some(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

export function auditSemanticPackageContracts(checkouts) {
  const packages = new Map(), files = [], directories = new Map();
  function walk(root, dir = root, owner = null) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (data.name) { owner = { root, dir, ...data }; packages.set(data.name, owner); }
    }
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(item.name)) continue;
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(root, file, owner);
      else if (item.isFile() && /\.[cm]?[jt]sx?$/.test(item.name) && !/(?:\.test|\.spec|\.d\.nl)\./.test(item.name)) files.push({ file, owner });
    }
  }
  for (const root of Object.values(checkouts)) {
    for (const { dir, scope } of BUILDABLE_UNIT_DIRS) {
      const units = path.join(root, dir);
      if (!scope || !fs.existsSync(units)) continue;
      for (const unit of fs.readdirSync(units, { withFileTypes: true }))
        if (unit.isDirectory()) directories.set(scope + unit.name, path.join(units, unit.name));
    }
    walk(root);
  }
  const findings = [], edges = [], classifications = [];
  for (const { file, owner } of files) {
    if (!owner) continue; // Non-buildable Natlang folders are loaded as programs, not JS packages.
    const text = fs.readFileSync(file, 'utf8');
    const companion = /(?:^|\/)suite\.[cm]?tsx?$/.test(file);
    const typeFile = file.endsWith('.d.ts');
    const testSupport = /\/(?:__tests__|testing)\//.test(file) || /native-channel-provider\.ts$/.test(file);
    for (const ref of workspaceReferences(text, file)) {
      const coordinate = moduleCoordinate(ref.specifier), target = packages.get(coordinate);
      if (!target && !directories.has(coordinate) && !/^@workspace-(?:skills|workers|panels|clients|about|extensions)\//.test(coordinate)) continue; // Host/platform or external namespace.
      const subpath = ref.specifier === coordinate ? '.' : '.' + ref.specifier.slice(coordinate.length);
      const item = { file: path.relative(owner.root, file), template: path.basename(owner.root), owner: owner.name,
        specifier: ref.specifier, kind: ref.kind, generated: ref.generated ?? false, line: ref.line };
      edges.push(item);
      const context = companion ? 'evaluation-companion' : typeFile ? 'ambient-types' : testSupport ? 'node-test-support' : 'runtime';
      if (context !== 'runtime') classifications.push({ ...item, context });
      if (!target) {
        const authoredProject = item.generated && [...text.matchAll(/projectType:\s*["'](worker|panel|extension|package)["']\s*,\s*name:\s*["']([^"']+)["']/g)]
          .some(([,kind,name]) => BUILDABLE_UNIT_DIRS.some(unit => unit.kind === kind && unit.scope + name === coordinate));
        if (authoredProject) classifications.push({ ...item, context: 'generated-project-package' });
        else findings.push({ ...item, issue: 'missing-package' });
        continue;
      }
      const conditions = companion || typeFile || ref.kind === 'type' ? ['types', 'import', 'default']
        : testSupport ? ['node', 'import', 'default'] : ['worker', 'browser', 'import', 'default'];
      const exported = target.exports === undefined ? (subpath === '.' ? target.main ?? target.module ?? './index.ts' : subpath)
        : resolveExportSubpath(target.exports, subpath, conditions);
      if (!exported) findings.push({ ...item, issue: 'missing-export', context });
      else if (!sourceTarget(target.dir, exported)) findings.push({ ...item, issue: 'missing-target', target: exported, context });
      // Emitted programs own their imports; adding their packages to the emitting
      // worker would incorrectly require every optional template in that worker.
      if (item.generated || context !== 'runtime') continue;
      const sections = ref.kind === 'type' ? ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
        : ['dependencies', 'peerDependencies', 'optionalDependencies'];
      if (coordinate !== owner.name && !sections.some(section => Object.hasOwn(owner[section] ?? {}, coordinate)))
        findings.push({ ...item, issue: 'undeclared-dependency' });
    }
  }
  return { templates: Object.keys(checkouts).length, packages: packages.size, sourceFiles: files.length,
    edges: edges.length, generatedImports: edges.filter(edge => edge.generated).length, findings, classifications };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selected = configuration.requireDevelopmentTemplateCheckouts(process.cwd());
  const report = auditSemanticPackageContracts(selected.checkouts);
  if (process.env.SEMANTIC_PACKAGE_AUDIT_OUTPUT) fs.writeFileSync(process.env.SEMANTIC_PACKAGE_AUDIT_OUTPUT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, findings: report.findings.length, classifications: report.classifications.length }));
  if (report.findings.length) process.exitCode = 1;
}
