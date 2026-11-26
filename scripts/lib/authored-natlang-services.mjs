import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { docComment } from "./json-schema-declarations.mjs";

function unwrap(node) {
  return node.type === "ExportNamedDeclaration" ? node.declaration ?? node : node;
}

function sourceFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const parsed = parse(text, { sourceType: "module", plugins: ["typescript"] });
  return { file, text, statements: parsed.program.body.map(unwrap).filter(Boolean) };
}

function resolveTypeFile(from, reference, resolveImport) {
  if (!reference.startsWith(".")) {
    const resolved = resolveImport?.(from.file, reference);
    if (resolved) return resolved;
    throw new Error(`Authored service type imports must be relative: ${reference} in ${from.file}`);
  }
  const file = path.resolve(path.dirname(from.file), reference).replace(/\.js$/u, ".ts");
  return fs.statSync(file,{throwIfNoEntry:false})?.isFile() ? file : resolveImport?.(from.file,reference) ?? file;
}

function render(node, from) {
  return from.text.slice(node.start, node.end).replace(/import\(["'][^"']+["']\)\./gu, "");
}

function serviceDeclaration(file, name) {
  const source = sourceFile(file);
  const declaration = source.statements
    .filter((node) => node.type === "TSModuleDeclaration" && node.id.value === "natlang:services")
    .flatMap((node) => node.body.body.map(unwrap))
    .filter((node) => node?.type === "VariableDeclaration")
    .flatMap((node) => node.declarations)
    .find((node) => node.id.type === "Identifier" && node.id.name === name);
  const type = declaration?.id.typeAnnotation?.typeAnnotation;
  if (type?.type !== "TSTypeLiteral") {
    throw new Error(`Declare ${name} as an object of service methods in ${file}`);
  }
  return { source, members: type.members };
}

/** Use the owning template's authored types while retaining the central method allowlist. */
export function renderAuthoredService(entry, file, {resolveTypeImport} = {}) {
  const { source, members } = serviceDeclaration(file, entry.name);
  const types = new Map();
  const imported = new Map([[file, source]]);
  const visited = new Set();
  const resolvedTypes = new Set();
  function load(from, reference) {
    const resolved = resolveTypeFile(from, reference, resolveTypeImport);
    if (!imported.has(resolved)) imported.set(resolved, sourceFile(resolved));
    return imported.get(resolved);
  }
  function includeType(from, name) {
    const key = from.file + ":" + name;
    const declaration = from.statements.find(
      node => (node.type === "TSTypeAliasDeclaration" || node.type === "TSInterfaceDeclaration") && node.id.name === name
    );
    if (visited.has(key)) return resolvedTypes.has(key) || Boolean(declaration);
    visited.add(key);
    if (declaration) {
      collect(declaration, from);
      const text = render(declaration, from);
      if (types.has(name) && types.get(name) !== text)
        throw new Error(`Conflicting type ${name} in service ${entry.name}`);
      types.set(name, text);
      resolvedTypes.add(key);
      return true;
    }
    for (const node of from.statements) {
      if (node.type !== "ImportDeclaration") continue;
      const match = node.specifiers.find(specifier => specifier.type === "ImportSpecifier" && specifier.local.name === name);
      if (!match) continue;
      const original = match.imported.name ?? match.imported.value;
      if (!includeType(load(from, node.source.value), original))
        throw new Error(`Unknown imported type ${original} in ${from.file}`);
      if (name !== original) types.set(name, `type ${name} = ${original};`);
      resolvedTypes.add(key);
      return true;
    }
    for (const node of from.statements) {
      if (node.type !== "ExportNamedDeclaration") continue;
      const match = node.specifiers.find(specifier => specifier.type === "ExportSpecifier" && (specifier.exported.name ?? specifier.exported.value) === name);
      if (!match) continue;
      const original = match.local.name ?? match.local.value;
      if (!includeType(node.source ? load(from,node.source.value) : from, original))
        throw new Error(`Unknown re-exported type ${original} in ${from.file}`);
      if (name !== original) types.set(name, `type ${name} = ${original};`);
      resolvedTypes.add(key);
      return true;
    }
    const owners = new Set();
    for (const node of from.statements) {
      if (node.type !== "ExportAllDeclaration") continue;
      const target = load(from,node.source.value);
      if (includeType(target,name)) owners.add(target.file);
    }
    if (owners.size > 1) throw new Error(`Ambiguous re-exported type ${name} in ${from.file}`);
    if (owners.size) { resolvedTypes.add(key); return true; }
    return false;
  }
  function collect(node, from) {
    if (node.type === "TSTypeReference" && node.typeName.type === "Identifier")
      includeType(from, node.typeName.name);
    if (
      node.type === "TSImportType" &&
      node.qualifier?.type === "Identifier" &&
      node.argument.type === "StringLiteral"
    ) {
      includeType(load(from, node.argument.value), node.qualifier.name);
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === "object" && typeof child.type === "string")
          collect(child, from);
      }
    }
  }
  const methods = entry.methods.map(({ name, params, description }) => {
    const method = members.find(
      (member) =>
        member.type === "TSMethodSignature" && !member.computed && member.key.name === name
    );
    if (
      !method ||
      JSON.stringify(method.parameters.map((param) => param.name)) !== JSON.stringify(params)
    )
      throw new Error(
        `Service ${entry.name}.${name} does not match its authored signature in ${file}`
      );
    collect(method, source);
    return `${docComment(description ?? entry.summary)}\nexport function ${render(method, source).replace(/;?$/u, ";")}`;
  });
  if (members.length !== methods.length)
    throw new Error(`Register every declared method of ${entry.name} in the service catalog`);
  return [docComment(entry.summary), ...types.values(), ...methods].join("\n\n");
}

/** Resolve only configured package exports to their actual source types; never execute authored modules. */
export function createAuthoredTypeResolver(units, mappings, {workspaces = [], checkouts = []} = {}) {
  return (from, specifier) => {
    if (specifier.startsWith(".")) {
      const candidate = path.resolve(path.dirname(from),specifier).replace(/\.js$/u,".ts");
      for (const project of [...workspaces].sort((a,b)=>b.root.length-a.root.length)) {
        const relative = path.relative(project.root,candidate).split(path.sep).join("/");
        if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) continue;
        const mounts = Object.entries(project.mounts).filter(([mount]) => relative.startsWith(mount+"/"));
        if (!mounts.length) continue;
        const [mount, source] = mounts.sort((a,b)=>b[0].length-a[0].length)[0];
        if (!mount.split("/").every(part=>/^[A-Za-z_][A-Za-z0-9_]*$/u.test(part)) ||
            typeof source!=="string" || !/^skills(?:\/[A-Za-z0-9_-]+)+$/u.test(source))
          throw new Error(`Invalid authored workspace type mount ${mount}`);
        const candidates = [...new Set([project.checkout,...checkouts])].map(checkout=>path.join(checkout,source)).filter(directory=>fs.statSync(directory,{throwIfNoEntry:false})?.isDirectory());
        const owned = path.join(project.checkout,source);
        const providers = candidates.includes(owned) ? [owned] : candidates;
        if (providers.length!==1) throw new Error(`Missing or ambiguous authored workspace type source ${source}`);
        const directory=providers[0], file=relative.slice(mount.length+1);
        const configFile=path.join(directory,"natlang.json"), config=fs.statSync(configFile,{throwIfNoEntry:false})?.isFile()?JSON.parse(fs.readFileSync(configFile,"utf8")):{};
        if (config.workspaceModules!==undefined || config.workspaceBranches!==undefined)
          throw new Error(`Mount ${source} as a self-contained type source`);
        if (config.include!==undefined && (!Array.isArray(config.include) || !config.include.some(prefix=>file===prefix||file.startsWith(prefix+"/"))))
          throw new Error(`Authored workspace type ${file} is not included in ${source}`);
        const target=path.join(directory,file);
        if (fs.statSync(target,{throwIfNoEntry:false})?.isFile()) return target;
        return null;
      }
      return null;
    }
    if (specifier.includes("\\") || specifier.split("/").some(part => !part || part === "." || part === "..")) return null;
    const owners = units.filter(unit => specifier === unit.name || specifier.startsWith(unit.name+"/"));
    if (owners.length > 1) throw new Error(`Ambiguous authored type package ${specifier}`);
    const unit = owners[0];
    if (!unit) return null;
    for (const {find, replacement} of mappings) {
      const [prefix, suffix] = find.split("*");
      let candidate;
      if (suffix === undefined) {
        if (specifier !== find) continue;
        candidate = replacement;
      } else {
        if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
        const wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
        candidate = replacement.replace("*", wildcard);
      }
      for (const file of [candidate, candidate.replace(/\.js$/u, ".ts"), candidate+".ts", path.join(candidate,"index.ts")]) {
        const relative = path.relative(unit.path, file);
        if (relative === ".." || relative.startsWith(".."+path.sep) || path.isAbsolute(relative)) continue;
        if (fs.statSync(file,{throwIfNoEntry:false})?.isFile()) return file;
      }
    }
    return null;
  };
}
