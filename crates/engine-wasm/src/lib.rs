//! The engine's WASM exports, flat-bytes ABI per `crates/engine-abi.md`.
//! JS writes packed arguments at `input_ptr`, calls one operation, and reads
//! `result_ptr`/`result_len`. Both regions live until the next call.

// The safety contract of every export is the pointer/length pairing in
// crates/engine-abi.md, so it is not repeated per function.
#![allow(clippy::missing_safety_doc)]

use core::cell::UnsafeCell;
use engine_core::{lz4_unpack, merge_sst_bytes, Codec, Entry, SstError};

const TAG_PUT: u8 = 1;
const TAG_DEL: u8 = 2;

const TRUNCATED: i32 = -5;
const BAD_TAG: i32 = -6;
const PATTERNS_TRUNCATED: i32 = -12;

/// The module is single-threaded, so a static buffer handed out by `&mut` is
/// never aliased across calls.
struct Slot(UnsafeCell<Vec<u8>>);
unsafe impl Sync for Slot {}

static INPUT: Slot = Slot(UnsafeCell::new(Vec::new()));
static RESULT: Slot = Slot(UnsafeCell::new(Vec::new()));

fn input() -> &'static mut Vec<u8> {
    unsafe { &mut *INPUT.0.get() }
}

fn result() -> &'static mut Vec<u8> {
    unsafe { &mut *RESULT.0.get() }
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
    }
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
    match r {
        Ok(v) => {
            *out = v;
            0
        }
        Err(code) => {
            out.clear();
            code
        }
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
    result().as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn result_len() -> u32 {
    result().len() as u32
}

#[no_mangle]
pub unsafe extern "C" fn encode_sst(ptr: *const u8, len: usize, lz4: i32) -> i32 {
    finish(
        parse_entries(bytes(ptr, len)).map(|entries| engine_core::encode_sst(&entries, codec(lz4))),
    )
}

#[no_mangle]
pub unsafe extern "C" fn decode_sst(ptr: *const u8, len: usize) -> i32 {
    let entries = match engine_core::decode_sst(bytes(ptr, len)) {
        Ok(e) => e,
        Err(e) => return finish(Err(error_code(e))),
    };
    let out = result();
    out.clear();
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

#[no_mangle]
pub unsafe extern "C" fn merge_ssts(
    ptr: *const u8,
    len: usize,
    drop_tombstones: i32,
    target_bytes: f64,
    lz4: i32,
) -> i32 {
    let mut r = Reader {
        buf: bytes(ptr, len),
        o: 0,
    };
    let Some(count) = r.u32() else {
        return finish(Err(TRUNCATED));
    };
    let mut blobs = Vec::new();
    for _ in 0..count {
        match r.u32().and_then(|n| r.take(n)) {
            Some(b) => blobs.push(b.to_vec()),
            None => return finish(Err(TRUNCATED)),
        }
    }
    // `as` saturates, so Number.MAX_SAFE_INTEGER becomes usize::MAX.
    let target = target_bytes as usize;
    finish(
        merge_sst_bytes(&blobs, drop_tombstones != 0, target, codec(lz4))
            .map(|(runs, dropped)| {
                let mut out =
                    Vec::with_capacity(12 + runs.iter().map(|s| 4 + s.len()).sum::<usize>());
                out.extend_from_slice(&dropped.to_le_bytes());
                out.extend_from_slice(&(runs.len() as u32).to_le_bytes());
                for run in &runs {
                    out.extend_from_slice(&(run.len() as u32).to_le_bytes());
                    out.extend_from_slice(run);
                }
                out
            })
            .map_err(error_code),
    )
}

#[cfg(target_family = "wasm")]
#[global_allocator]
static ALLOC: talc::wasm::WasmDynamicTalc = talc::wasm::new_wasm_dynamic_allocator();
