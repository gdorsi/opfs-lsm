//! The engine's WASM exports, flat-bytes ABI per `crates/engine-abi.md`.
//! JS writes packed arguments at `input_ptr`, calls one operation, and reads
//! `result_ptr`/`result_len`. Both regions live until the next call.

// The safety contract of every export is the pointer/length pairing in
// crates/engine-abi.md, so it is not repeated per function.
#![allow(clippy::missing_safety_doc)]
#![cfg_attr(target_family = "wasm", no_std)]

extern crate alloc;

use alloc::{vec, vec::Vec};

use core::cell::UnsafeCell;
use engine_core::{
    encode_run_into, lz4_unpack, Codec, Entry, MergeConfig, MergeError, MergeSession, RunEnd, SstError, Stop,
};

const TAG_PUT: u8 = 1;
const TAG_DEL: u8 = 2;

const TRUNCATED: i32 = -5;
const BAD_TAG: i32 = -6;
const OUT_OF_MEMORY: i32 = -11;
const PATTERNS_TRUNCATED: i32 = -12;
const SESSION_OPEN: i32 = -13;
const OUT_OF_ORDER: i32 = -14;
const NO_SESSION: i32 = -15;
const UNFED: i32 = -16;

const NEED: i32 = 1;
const WRITE: i32 = 2;
const RUN_END: i32 = 3;
const YIELD: i32 = 4;
const DONE: i32 = 5;

/// Bytes of a run record's fixed head: entries, size, first and last key length.
const RUN_HEAD: usize = 16;

/// The module is single-threaded, so a static handed out by `&mut` is never
/// aliased across calls.
struct Static<T>(UnsafeCell<T>);
unsafe impl<T> Sync for Static<T> {}

static INPUT: Static<Vec<u8>> = Static(UnsafeCell::new(Vec::new()));
static RESULT: Static<Vec<u8>> = Static(UnsafeCell::new(Vec::new()));
/// What `result_ptr` and `result_len` report: `RESULT`, or the bytes a
/// session's `Write` hands out, which are not copied.
static VIEW: Static<(u32, u32)> = Static(UnsafeCell::new((0, 0)));
/// The one merge session a module holds.
static SESSION: Static<Option<MergeSession>> = Static(UnsafeCell::new(None));

fn input() -> &'static mut Vec<u8> {
    unsafe { &mut *INPUT.0.get() }
}

fn result() -> &'static mut Vec<u8> {
    unsafe { &mut *RESULT.0.get() }
}

fn session() -> &'static mut Option<MergeSession> {
    unsafe { &mut *SESSION.0.get() }
}

fn show(bytes: &[u8]) {
    unsafe { *VIEW.0.get() = (bytes.as_ptr() as u32, bytes.len() as u32) }
}

/// Clear `RESULT`, let `fill` write it, and point the view at it.
fn show_result(fill: impl FnOnce(&mut Vec<u8>)) {
    let out = result();
    out.clear();
    fill(out);
    show(out);
}

fn error_code(e: SstError) -> i32 {
    match e {
        SstError::TooShort => -1,
        SstError::BadMagic(_) => -2,
        SstError::BadVersion(_) => -3,
        SstError::CrcMismatch => -4,
        SstError::Truncated => TRUNCATED,
        SstError::BadTag(_) => BAD_TAG,
        SstError::TrailingGarbage => -7,
        SstError::CountMismatch => -8,
        SstError::BadCodec(_) => -9,
        SstError::BadBlock => -10,
        SstError::OutOfOrder => OUT_OF_ORDER,
    }
}

/// The fixed head of a run record, from what the writer reported.
fn run_head(end: &RunEnd) -> [u8; RUN_HEAD] {
    let mut head = [0u8; RUN_HEAD];
    let fields = [end.entries, end.size, end.first_key.len(), end.last_key.len()];
    for (slot, n) in head.chunks_exact_mut(4).zip(fields) {
        slot.copy_from_slice(&(n as u32).to_le_bytes());
    }
    head
}

fn codec(lz4: i32) -> Codec {
    if lz4 != 0 {
        Codec::Lz4
    } else {
        Codec::Raw
    }
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        core::slice::from_raw_parts(ptr, len)
    }
}

fn finish(r: Result<Vec<u8>, i32>) -> i32 {
    let out = result();
    let status = match r {
        Ok(v) => {
            *out = v;
            0
        }
        Err(code) => {
            out.clear();
            code
        }
    };
    show(out);
    status
}

fn merge_error(e: MergeError) -> i32 {
    match e {
        MergeError::Corrupt(e) => error_code(e),
        MergeError::OutOfMemory => OUT_OF_MEMORY,
        MergeError::Unfed => UNFED,
    }
}

struct Reader<'a> {
    buf: &'a [u8],
    o: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if n > self.buf.len() - self.o {
            return None;
        }
        let s = &self.buf[self.o..self.o + n];
        self.o += n;
        Some(s)
    }
    fn u32(&mut self) -> Option<usize> {
        self.take(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()) as usize)
    }
    fn u64(&mut self) -> Option<u64> {
        self.take(8)
            .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
    }
    fn done(&self) -> bool {
        self.o == self.buf.len()
    }
}

fn parse_entries(buf: &[u8]) -> Result<Vec<Entry>, i32> {
    let mut r = Reader { buf, o: 0 };
    let mut out = Vec::new();
    while !r.done() {
        let tag = r.take(1).ok_or(TRUNCATED)?[0];
        let seq = r.u64().ok_or(TRUNCATED)?;
        let klen = r.u32().ok_or(TRUNCATED)?;
        let key = r.take(klen).ok_or(TRUNCATED)?.to_vec();
        out.push(match tag {
            TAG_PUT => {
                let vlen = r.u32().ok_or(TRUNCATED)?;
                let value = r.take(vlen).ok_or(TRUNCATED)?.to_vec();
                Entry::Put { key, value, seq }
            }
            TAG_DEL => Entry::Del { key, seq },
            _ => return Err(BAD_TAG),
        });
    }
    Ok(out)
}

#[no_mangle]
pub extern "C" fn init(_capacity: u32) -> i32 {
    0
}

#[no_mangle]
pub extern "C" fn input_ptr(len: u32) -> u32 {
    let buf = input();
    let len = len as usize;
    if len > buf.len() && buf.try_reserve_exact(len - buf.len()).is_err() {
        return 0;
    }
    buf.resize(buf.len().max(len), 0);
    buf.as_mut_ptr() as u32
}

#[no_mangle]
pub extern "C" fn result_ptr() -> u32 {
    unsafe { (*VIEW.0.get()).0 }
}

#[no_mangle]
pub extern "C" fn result_len() -> u32 {
    unsafe { (*VIEW.0.get()).1 }
}

#[no_mangle]
pub unsafe extern "C" fn encode_sst(ptr: *const u8, len: usize, lz4: i32) -> i32 {
    finish(parse_entries(bytes(ptr, len)).map(|entries| {
        // The run is written after room for its head, so it is never copied.
        let mut out = vec![0u8; RUN_HEAD];
        let end = encode_run_into(&entries, codec(lz4), &mut out);
        out[..RUN_HEAD].copy_from_slice(&run_head(&end));
        out.extend_from_slice(&end.first_key);
        out.extend_from_slice(&end.last_key);
        out
    }))
}

#[no_mangle]
pub unsafe extern "C" fn decode_sst(ptr: *const u8, len: usize) -> i32 {
    let entries = match engine_core::decode_sst(bytes(ptr, len)) {
        Ok(e) => e,
        Err(e) => return finish(Err(error_code(e))),
    };
    show_result(|out| {
        for e in &entries {
            let (tag, key, value, seq) = match e {
                Entry::Put { key, value, seq } => (TAG_PUT, key, Some(value), *seq),
                Entry::Del { key, seq } => (TAG_DEL, key, None, *seq),
            };
            out.push(tag);
            out.extend_from_slice(&seq.to_le_bytes());
            out.extend_from_slice(&(key.len() as u32).to_le_bytes());
            out.extend_from_slice(key);
            if let Some(v) = value {
                out.extend_from_slice(&(v.len() as u32).to_le_bytes());
                out.extend_from_slice(v);
            }
        }
    });
    0
}

#[no_mangle]
pub unsafe extern "C" fn lz4_decompress(ptr: *const u8, len: usize, size: u32) -> i32 {
    finish(lz4_unpack(bytes(ptr, len), size as usize).map_err(error_code))
}

#[no_mangle]
pub unsafe extern "C" fn scan_block_contains(
    ptr: *const u8,
    len: usize,
    lz4: i32,
    pat_ptr: *const u8,
    pat_len: usize,
) -> i32 {
    let mut r = Reader {
        buf: bytes(pat_ptr, pat_len),
        o: 0,
    };
    let mut pats = Vec::new();
    while !r.done() {
        let Some(p) = r.u32().and_then(|n| r.take(n)) else {
            return finish(Err(PATTERNS_TRUNCATED));
        };
        pats.push(p);
    }
    finish(engine_core::scan_block_contains(bytes(ptr, len), codec(lz4), &pats).map_err(error_code))
}

/// Open the module's merge session. Input: source list. Fails with -13
/// while a session is open, -5 for a malformed list, -1 for a run shorter
/// than a footer, and -11 when its working set cannot be reserved.
#[no_mangle]
pub unsafe extern "C" fn merge_open(
    ptr: *const u8,
    len: usize,
    drop_tombstones: i32,
    target_bytes: f64,
    lz4: i32,
    chunk_bytes: u32,
    tail_bytes: u32,
    yield_bytes: u32,
) -> i32 {
    show(&[]);
    let slot = session();
    if slot.is_some() {
        return SESSION_OPEN;
    }
    let mut r = Reader {
        buf: bytes(ptr, len),
        o: 0,
    };
    let Some(count) = r.u32() else { return TRUNCATED };
    let mut sources = Vec::new();
    for _ in 0..count {
        let Some(runs) = r.u32() else { return TRUNCATED };
        let mut sizes = Vec::new();
        for _ in 0..runs {
            let Some(size) = r.u32() else { return TRUNCATED };
            sizes.push(size as u32);
        }
        sources.push(sizes);
    }
    if !r.done() {
        return TRUNCATED;
    }
    let config = MergeConfig {
        drop_tombstones: drop_tombstones != 0,
        // `as` saturates, so Number.MAX_SAFE_INTEGER becomes usize::MAX.
        target_bytes: target_bytes as usize,
        codec: codec(lz4),
        chunk_bytes: chunk_bytes as usize,
        tail_bytes: tail_bytes as usize,
        yield_bytes: yield_bytes as usize,
    };
    match MergeSession::open(config, &sources) {
        Ok(s) => {
            *slot = Some(s);
            0
        }
        Err(e) => merge_error(e),
    }
}

/// Run the session to its next stop. The result holds the stop's bytes:
/// demand records for NEED, output bytes for WRITE (in the session's own
/// buffer), a run head and keys for RUN_END, u64 dropped seq for DONE.
#[no_mangle]
pub extern "C" fn merge_pump() -> i32 {
    show(&[]);
    let Some(s) = session() else { return NO_SESSION };
    match s.pump() {
        Ok(Stop::Need(demands)) => {
            show_result(|out| {
                for d in demands {
                    for v in [d.source, d.run, d.offset, d.len] {
                        out.extend_from_slice(&v.to_le_bytes());
                    }
                }
            });
            NEED
        }
        Ok(Stop::Write(bytes)) => {
            show(bytes);
            WRITE
        }
        Ok(Stop::RunEnd(end)) => {
            show_result(|out| {
                out.extend_from_slice(&run_head(end));
                out.extend_from_slice(&end.first_key);
                out.extend_from_slice(&end.last_key);
            });
            RUN_END
        }
        Ok(Stop::Yield) => YIELD,
        Ok(Stop::Done(dropped)) => {
            show_result(|out| out.extend_from_slice(&dropped.to_le_bytes()));
            DONE
        }
        Err(e) => merge_error(e),
    }
}

/// Where the bytes of `source`'s demand go: JS writes exactly `len` bytes
/// there before the next pump. 0 when `source` has no unfed demand of that
/// length.
#[no_mangle]
pub extern "C" fn merge_feed(source: u32, len: u32) -> u32 {
    let Some(s) = session() else { return 0 };
    s.feed(source as usize, len as usize).map_or(0, |b| b.as_mut_ptr() as u32)
}

/// Drop the session and its buffers. Safe to call with none open.
#[no_mangle]
pub extern "C" fn merge_close() -> i32 {
    show(&[]);
    *session() = None;
    0
}

#[cfg(target_family = "wasm")]
#[global_allocator]
static ALLOC: talc::wasm::WasmDynamicTalc = talc::wasm::new_wasm_dynamic_allocator();

/// Every panic in the module is a bug or a refused allocation. JS sees a
/// trap, as it did under std's abort, and the message machinery is not linked.
#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
