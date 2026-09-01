import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createRequire } from "node:module";

/**
 * A very small bundler.
 *
 * The engine has no dependencies and imports nothing but its own relative
 * `.ts` files, so a full bundler would be more machinery than the problem
 * needs. This walks the import graph from an entry point, transpiles each file
 * with the TypeScript compiler's isolated-module transpiler — which is exactly
 * what `node --experimental-strip-types` does, so the browser runs the same
 * code the tests run — and emits one IIFE with a tiny module registry.
 *
 * Nothing here is clever, and that is deliberate: the browser must execute the
 * engine, not a re-implementation of it.
 */

const require = createRequire(import.meta.url);
// TypeScript is installed globally in this environment rather than as a project
// dependency; resolve it from there when the local lookup fails.
function loadTypeScript(): typeof import("typescript") {
  try {
    return require("typescript");
  } catch {
    return require("/opt/node22/lib/node_modules/typescript");
  }
}

const IMPORT_RE = /(?:^|[\s;{(])(?:import|export)\s+(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g;
const BARE_IMPORT_RE = /(?:^|[\s;])import\s+["']([^"']+)["']/g;

export interface BundleOptions {
  /** Name of the global the entry module's exports are assigned to. */
  globalName: string;
  /** Root the module ids are expressed relative to; only affects readability. */
  root: string;
}

export function bundle(entryPath: string, options: BundleOptions): string {
  const ts = loadTypeScript();
  const entry = resolve(entryPath);
  const modules = new Map<string, string>();
  const order: string[] = [];

  const idOf = (absolute: string): string => relative(options.root, absolute).split("\\").join("/");

  const visit = (absolute: string): void => {
    const id = idOf(absolute);
    if (modules.has(id)) return;
    const source = readFileSync(absolute, "utf8");
    modules.set(id, ""); // reserve, so a cycle terminates
    order.push(id);

    const specifiers = new Set<string>();
    for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source))) specifiers.add(m[1]);
    }
    for (const spec of specifiers) {
      if (!spec.startsWith(".")) {
        throw new Error(`${id}: only relative imports can be bundled, found "${spec}"`);
      }
      visit(resolve(dirname(absolute), spec));
    }

    const out = ts.transpileModule(source, {
      fileName: absolute,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        isolatedModules: true,
        removeComments: false,
      },
    });
    modules.set(id, out.outputText);
  };

  visit(entry);

  const parts: string[] = [];
  parts.push(`(function () {\n"use strict";\nvar __defs = {};\nvar __cache = {};`);
  parts.push(`function __resolve(from, spec) {
  var base = from.split("/");
  base.pop();
  var segments = spec.split("/");
  for (var i = 0; i < segments.length; i++) {
    var s = segments[i];
    if (s === "." || s === "") continue;
    if (s === "..") base.pop();
    else base.push(s);
  }
  return base.join("/");
}
function __require(id) {
  if (__cache[id]) return __cache[id].exports;
  var mod = (__cache[id] = { exports: {} });
  var def = __defs[id];
  if (!def) throw new Error("module not bundled: " + id);
  def(mod.exports, function (spec) { return __require(__resolve(id, spec)); }, mod);
  return mod.exports;
}`);

  for (const id of order) {
    parts.push(
      `__defs[${JSON.stringify(id)}] = function (exports, require, module) {\n${modules.get(id)}\n};`,
    );
  }

  parts.push(
    `var __entry = __require(${JSON.stringify(idOf(entry))});\n` +
      `globalThis[${JSON.stringify(options.globalName)}] = __entry;\n})();`,
  );

  return parts.join("\n\n");
}
