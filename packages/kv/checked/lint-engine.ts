/**
 * `lint:engine`, part of `pnpm static`: oxlint and fallow cannot parse the
 * AssemblyScript engine, so asc checks it. Fails on any diagnostic under
 * `--pedantic`, and on any function or method under engine/ that asc never
 * compiled: asc compiles lazily from the exports, so one it never compiled
 * is dead. `@inline` declarations are left out, since asc inlines them
 * without recording a compiled instance, and so are `@global` ones, which the
 * compiler calls.
 *
 *   pnpm --filter @opfs-lsm/kv lint:engine
 */
import asc from "assemblyscript/asc";
import { Transform } from "assemblyscript/transform";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KV = join(dirname(fileURLToPath(import.meta.url)), "..");
/** asc's DecoratorFlags.Global and DecoratorFlags.Inline. */
const GLOBAL_OR_INLINE = 1 | 64;

const unused: string[] = [];

class Unused extends Transform {
  afterCompile(m) {
    const b = this.binaryen;
    const compiled = new Set<string>();
    for (let i = 0; i < m.getNumFunctions(); i++) compiled.add(b.getFunctionInfo(m.getFunctionByIndex(i)).name);
    const seen = new Set();
    const visit = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      const name: string = el.internalName ?? "";
      if (name.startsWith("engine/") && "instances" in el && !el.instances?.size && !compiled.has(name) && !(el.decoratorFlags & GLOBAL_OR_INLINE)) unused.push(name);
      for (const member of el.members?.values() ?? []) visit(member);
      for (const member of el.instanceMembers?.values() ?? []) visit(member);
      visit(el.getterPrototype);
      visit(el.setterPrototype);
    };
    for (const el of this.program.elementsByName.values()) visit(el);
  }
}

const diagnostics: string[] = [];
const { error, stderr } = await asc.main(["engine/index.ts", "--baseDir", KV, "--runtime", "engine/runtime", "--use", "abort=", "--noEmit", "--pedantic"], {
  transforms: [Unused],
  reportDiagnostic: (d) => diagnostics.push(d.range ? `${d.range.source.normalizedPath}: ${d.message}` : d.message),
});
const problems = [...diagnostics, ...[...new Set(unused)].sort().map((name) => `never compiled, so unused: ${name}`)];
if (error && !diagnostics.length) problems.push(`${error.message}\n${stderr.toString()}`);
for (const problem of problems) console.error(`lint:engine: ${problem}`);
console.log(problems.length ? `lint:engine: ${problems.length} problems` : "lint:engine: ok");
process.exit(problems.length ? 1 : 0);
