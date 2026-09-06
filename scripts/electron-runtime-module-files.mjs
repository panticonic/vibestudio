// Vibestudio compiles and typechecks workspace code after installation. Type
// declarations are runtime inputs, including tsgo's bundled standard library.
// electron-builder otherwise drops them as development-only package contents.
export default function includeRuntimeModuleFile(filename) {
  return filename.endsWith(".d.ts") ? true : undefined;
}
