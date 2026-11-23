/**
 * The asc transform that turns the engine into its checked twin. It runs on
 * the unoptimized module, so it sees every load, store, copy and fill that
 * the source or the compiler emits, and the function names. Every check it
 * adds calls a `san` import, which checked/shadow.ts provides; the twin
 * imports nothing else, so it drops in wherever the shipped build loads.
 *
 * - Outside the allocator, each load and store calls the import of its kind
 *   first, and each copy and fill goes through a function that does. The
 *   allocator writes headers and free list links into freed payloads, so its
 *   own accesses stay raw.
 * - Calls to `tryAlloc`, `tryRealloc` and `free` from outside the allocator
 *   go through wrappers that ask for REDZONE more bytes and report each
 *   block. `san.free` holds a freed block back for a while and returns the
 *   one the allocator may now reuse.
 * - Each export of the ABI reports its call and its return, with its result
 *   and first two arguments, so the shadow checks the host boundary.
 * - Each function entry, if arm and loop head bumps a coverage counter.
 * - The start function reports where the heap starts and how many counters
 *   there are, runs the module's own start, then one empty encode, which
 *   allocates the module's input and result buffers, and reports it is ready.
 */
import { Transform } from "assemblyscript/transform";
import { BOUNDARY } from "./shadow.ts";

const ALLOC = "engine/alloc/";
const WRAPPED = ["tryAlloc", "tryRealloc", "free"];
/** Bytes past each block that only a bug touches. */
const REDZONE = 16;

export class Instrument extends Transform {
  // fallow-ignore-next-line unused-class-member
  afterCompile(m) {
    const b = this.binaryen;
    const { i32, f64, none } = b;
    const sig = (...ts) => b.createType(ts);
    const hook = (name, params, result) => m.addFunctionImport(`san/${name}`, "san", name, sig(...params), result);
    hook("load", [i32, i32, i32], i32);
    hook("store", [i32, i32, i32], i32);
    hook("copy", [i32, i32, i32], none);
    hook("fill", [i32, i32], none);
    hook("alloc", [i32, i32, i32], i32);
    hook("realloc", [i32, i32, i32, i32], i32);
    hook("free", [i32], i32);
    hook("cov", [i32], none);
    hook("start", [i32, i32], none);
    hook("ready", [], none);
    hook("enter", [i32], none);
    hook("leave", [i32, i32, i32, i32], none);

    let edges = 0;
    const cov = () => m.call("san/cov", [m.i32.const(edges++)], none);
    const counted = (e) => m.block(null, [cov(), e], b.getExpressionType(e));

    const visit = (e, raw) => {
      if (!e) return e;
      const v = (x) => visit(x, raw);
      switch (b.getExpressionId(e)) {
        case b.NopId:
        case b.LocalGetId:
        case b.GlobalGetId:
        case b.ConstId:
        case b.UnreachableId:
        case b.MemorySizeId:
          return e;
        case b.BlockId: {
          for (let i = 0, n = b.Block.getNumChildren(e); i < n; i++) b.Block.setChildAt(e, i, v(b.Block.getChildAt(e, i)));
          return e;
        }
        case b.IfId: {
          b.If.setCondition(e, v(b.If.getCondition(e)));
          b.If.setIfTrue(e, counted(v(b.If.getIfTrue(e))));
          const f = b.If.getIfFalse(e);
          b.If.setIfFalse(e, f ? counted(v(f)) : cov());
          return e;
        }
        case b.LoopId:
          b.Loop.setBody(e, counted(v(b.Loop.getBody(e))));
          return e;
        case b.BreakId:
          b.Break.setCondition(e, v(b.Break.getCondition(e)));
          b.Break.setValue(e, v(b.Break.getValue(e)));
          return e;
        case b.SwitchId:
          b.Switch.setCondition(e, v(b.Switch.getCondition(e)));
          b.Switch.setValue(e, v(b.Switch.getValue(e)));
          return e;
        case b.CallId: {
          for (let i = 0, n = b.Call.getNumOperands(e); i < n; i++) b.Call.setOperandAt(e, i, v(b.Call.getOperandAt(e, i)));
          const target = b.Call.getTarget(e);
          if (!raw && target.startsWith(ALLOC) && WRAPPED.includes(target.slice(ALLOC.length))) b.Call.setTarget(e, `${target}~san`);
          return e;
        }
        case b.CallIndirectId: {
          b.CallIndirect.setTarget(e, v(b.CallIndirect.getTarget(e)));
          for (let i = 0, n = b.CallIndirect.getNumOperands(e); i < n; i++) b.CallIndirect.setOperandAt(e, i, v(b.CallIndirect.getOperandAt(e, i)));
          return e;
        }
        case b.LocalSetId:
          b.LocalSet.setValue(e, v(b.LocalSet.getValue(e)));
          return e;
        case b.GlobalSetId:
          b.GlobalSet.setValue(e, v(b.GlobalSet.getValue(e)));
          return e;
        case b.UnaryId:
          b.Unary.setValue(e, v(b.Unary.getValue(e)));
          return e;
        case b.BinaryId:
          b.Binary.setLeft(e, v(b.Binary.getLeft(e)));
          b.Binary.setRight(e, v(b.Binary.getRight(e)));
          return e;
        case b.SelectId:
          b.Select.setIfTrue(e, v(b.Select.getIfTrue(e)));
          b.Select.setIfFalse(e, v(b.Select.getIfFalse(e)));
          b.Select.setCondition(e, v(b.Select.getCondition(e)));
          return e;
        case b.DropId:
          b.Drop.setValue(e, v(b.Drop.getValue(e)));
          return e;
        case b.ReturnId:
          b.Return.setValue(e, v(b.Return.getValue(e)));
          return e;
        case b.MemoryGrowId:
          b.MemoryGrow.setDelta(e, v(b.MemoryGrow.getDelta(e)));
          return e;
        case b.LoadId: {
          const ptr = v(b.Load.getPtr(e));
          b.Load.setPtr(e, raw ? ptr : m.call("san/load", [ptr, m.i32.const(b.Load.getOffset(e)), m.i32.const(b.Load.getBytes(e))], i32));
          return e;
        }
        case b.StoreId: {
          const ptr = v(b.Store.getPtr(e));
          b.Store.setValue(e, v(b.Store.getValue(e)));
          b.Store.setPtr(e, raw ? ptr : m.call("san/store", [ptr, m.i32.const(b.Store.getOffset(e)), m.i32.const(b.Store.getBytes(e))], i32));
          return e;
        }
        case b.MemoryCopyId: {
          const args = [v(b.MemoryCopy.getDest(e)), v(b.MemoryCopy.getSource(e)), v(b.MemoryCopy.getSize(e))];
          if (!raw) return m.call("~san/copy", args, none);
          b.MemoryCopy.setDest(e, args[0]);
          b.MemoryCopy.setSource(e, args[1]);
          b.MemoryCopy.setSize(e, args[2]);
          return e;
        }
        case b.MemoryFillId: {
          const args = [v(b.MemoryFill.getDest(e)), v(b.MemoryFill.getValue(e)), v(b.MemoryFill.getSize(e))];
          if (!raw) return m.call("~san/fill", args, none);
          b.MemoryFill.setDest(e, args[0]);
          b.MemoryFill.setValue(e, args[1]);
          b.MemoryFill.setSize(e, args[2]);
          return e;
        }
        default:
          throw new Error(`instrument: no rule for expression id ${b.getExpressionId(e)}`);
      }
    };

    for (let i = 0, n = m.getNumFunctions(); i < n; i++) {
      const f = m.getFunctionByIndex(i);
      const info = b.getFunctionInfo(f);
      if (info.base || !info.body) continue;
      b.Function.setBody(f, counted(visit(info.body, info.name.startsWith(ALLOC))));
    }

    const arg = (k, t = i32) => m.local.get(k, t);
    m.addFunction("~san/copy", sig(i32, i32, i32), none, [], m.block(null, [m.call("san/copy", [arg(0), arg(1), arg(2)], none), m.memory.copy(arg(0), arg(1), arg(2))]));
    m.addFunction("~san/fill", sig(i32, i32, i32), none, [], m.block(null, [m.call("san/fill", [arg(0), arg(2)], none), m.memory.fill(arg(0), arg(1), arg(2))]));

    // A request so large that the redzone wraps it around stays as it is, so the allocator refuses it as the shipped build does.
    const padded = (k) => {
      const plus = () => m.i32.add(arg(k), m.i32.const(REDZONE));
      return m.select(m.i32.gt_u(plus(), arg(k)), plus(), arg(k));
    };
    /** The size of the block at `ptr`, header included, from the allocator's header; 0 for no block. */
    const blockBytes = (k) => m.if(arg(k), m.i32.load(0, 4, m.i32.sub(arg(k), m.i32.const(4))), m.i32.const(0));
    m.addFunction(`${ALLOC}tryAlloc~san`, sig(i32), i32, [], m.call("~san/placed", [m.call(`${ALLOC}tryAlloc`, [padded(0)], i32), arg(0)], i32));
    m.addFunction("~san/placed", sig(i32, i32), i32, [], m.call("san/alloc", [arg(0), arg(1), blockBytes(0)], i32));
    m.addFunction(`${ALLOC}tryRealloc~san`, sig(i32, i32), i32, [], m.call("~san/moved", [arg(0), arg(1), m.call(`${ALLOC}tryRealloc`, [arg(0), padded(1)], i32)], i32));
    m.addFunction("~san/moved", sig(i32, i32, i32), i32, [], m.call("san/realloc", [arg(0), arg(1), arg(2), blockBytes(2)], i32));
    m.addFunction(`${ALLOC}free~san`, sig(i32), none, [], m.call(`${ALLOC}free`, [m.call("san/free", [arg(0)], i32)], none));

    const internal = new Map<string, string>();
    for (let i = 0, n = m.getNumExports(); i < n; i++) {
      const e = b.getExportInfo(m.getExportByIndex(i));
      if (e.kind === b.ExternalFunction) internal.set(e.name, e.value);
    }
    if ([...internal.keys()].sort().join() !== [...BOUNDARY].sort().join()) throw new Error(`instrument: the exports are ${[...internal.keys()]}, the shadow knows ${BOUNDARY}`);
    BOUNDARY.forEach((name, id) => {
      const target = internal.get(name)!;
      const f = b.getFunctionInfo(m.getFunction(target));
      const params = b.expandType(f.params);
      if (f.results !== i32 || params.some((t) => t !== i32 && t !== f64)) throw new Error(`instrument: ${name} has a signature the boundary does not know`);
      const result = params.length;
      const first = name === "result_len" ? m.call(internal.get("result_ptr")!, [], i32) : params[0] === i32 ? arg(0) : m.i32.const(0);
      const second = params[1] === i32 ? arg(1) : m.i32.const(0);
      const body = m.block(
        null,
        [
          m.call("san/enter", [m.i32.const(id)], none),
          m.local.set(result, m.call(target, params.map((t, k) => arg(k, t)), i32)),
          m.call("san/leave", [m.i32.const(id), arg(result), first, second], none),
          arg(result),
        ],
        i32,
      );
      m.addFunction(`~san/${name}`, f.params, i32, [i32], body);
      m.removeExport(name);
      m.addFunctionExport(`~san/${name}`, name);
    });

    const start = m.getFunction("~start") ? [m.call("~start", [], none)] : [];
    m.addFunction(
      "~san/start",
      none,
      none,
      [],
      m.block(null, [
        m.call("san/start", [m.global.get("~lib/memory/__heap_base", i32), m.i32.const(edges)], none),
        ...start,
        m.drop(m.call(internal.get("encode_sst")!, [m.call(internal.get("input_ptr")!, [m.i32.const(0)], i32), m.i32.const(0)], i32)),
        m.call("san/ready", [], none),
      ]),
    );
    m.setStart(m.getFunction("~san/start"));
  }
}
