use engine_core::{decode_sst, encode_sst, merge_sst_bytes, scan_block_contains, Codec, Entry};
use js_sys::{Array, Uint8Array};
use wasm_bindgen::prelude::*;

fn codec(lz4: bool) -> Codec {
    if lz4 {
        Codec::Lz4
    } else {
        Codec::Raw
    }
}

/// Encode entries from JS: `[{kind:'put'|'del', key:Uint8Array, value?:Uint8Array, seq?:number}, ...]`
#[wasm_bindgen]
pub fn encode_sst_js(entries: Array, lz4: bool) -> Result<Uint8Array, JsValue> {
    let mut rust_entries = Vec::with_capacity(entries.length() as usize);
    for i in 0..entries.length() {
        let obj = js_sys::Object::from(entries.get(i));
        let kind = js_sys::Reflect::get(&obj, &"kind".into())?
            .as_string()
            .ok_or_else(|| JsValue::from_str("entry.kind"))?;
        let key = Uint8Array::new(&js_sys::Reflect::get(&obj, &"key".into())?);
        let key = key.to_vec();
        let seq = js_sys::Reflect::get(&obj, &"seq".into())?
            .as_f64()
            .unwrap_or(0.0) as u64;
        let e = match kind.as_str() {
            "put" => {
                let value = Uint8Array::new(&js_sys::Reflect::get(&obj, &"value".into())?);
                Entry::Put {
                    key,
                    value: value.to_vec(),
                    seq,
                }
            }
            "del" => Entry::Del { key, seq },
            _ => return Err(JsValue::from_str("bad kind")),
        };
        rust_entries.push(e);
    }
    let bytes = encode_sst(&rust_entries, codec(lz4));
    Ok(Uint8Array::from(bytes.as_slice()))
}

/// Unpack one LZ4 block of exactly `size` bytes. Reads call this per block,
/// so it takes and returns plain bytes.
#[wasm_bindgen]
pub fn lz4_decompress_js(src: &[u8], size: usize) -> Result<Vec<u8>, JsValue> {
    match lz4_flex::block::decompress(src, size) {
        Ok(out) if out.len() == size => Ok(out),
        _ => Err(JsValue::from_str("lz4 block corrupt")),
    }
}

/// The puts of one data block, as the run's block index frames it, whose value
/// contains every pattern. `patterns` is each pattern as a little-endian u32
/// length then its bytes. Hits come back as `u32 key_len, u32 value_len, key,
/// value` records in key order.
#[wasm_bindgen]
pub fn scan_block_contains_js(framed: &[u8], lz4: bool, patterns: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut pats: Vec<&[u8]> = Vec::new();
    let mut o = 0;
    while o < patterns.len() {
        if o + 4 > patterns.len() {
            return Err(JsValue::from_str("patterns truncated"));
        }
        let n = u32::from_le_bytes(patterns[o..o + 4].try_into().unwrap()) as usize;
        o += 4;
        if o + n > patterns.len() {
            return Err(JsValue::from_str("patterns truncated"));
        }
        pats.push(&patterns[o..o + n]);
        o += n;
    }
    scan_block_contains(framed, codec(lz4), &pats).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Decode SST bytes to JS array of entries.
#[wasm_bindgen]
pub fn decode_sst_js(buf: Uint8Array) -> Result<Array, JsValue> {
    let entries =
        decode_sst(&buf.to_vec()).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let out = Array::new();
    for e in entries {
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &"seq".into(), &JsValue::from_f64(e.seq() as f64))?;
        match e {
            Entry::Put { key, value, .. } => {
                js_sys::Reflect::set(&obj, &"kind".into(), &"put".into())?;
                js_sys::Reflect::set(&obj, &"key".into(), &Uint8Array::from(key.as_slice()))?;
                js_sys::Reflect::set(
                    &obj,
                    &"value".into(),
                    &Uint8Array::from(value.as_slice()),
                )?;
            }
            Entry::Del { key, .. } => {
                js_sys::Reflect::set(&obj, &"kind".into(), &"del".into())?;
                js_sys::Reflect::set(&obj, &"key".into(), &Uint8Array::from(key.as_slice()))?;
            }
        }
        out.push(&obj);
    }
    Ok(out)
}

/// Merge newest-first SST blobs into SSTs of about `target_bytes`, in key
/// order, with LZ4 blocks when `lz4` is set. `drop_tombstones` is for a
/// merge nothing older overlaps. Returns `{ssts, droppedSeq}`, where
/// droppedSeq is the highest seq of a dropped tombstone, 0 when none.
#[wasm_bindgen]
pub fn merge_ssts_js(
    blobs: Array,
    drop_tombstones: bool,
    target_bytes: f64,
    lz4: bool,
) -> Result<js_sys::Object, JsValue> {
    let mut vecs = Vec::with_capacity(blobs.length() as usize);
    for i in 0..blobs.length() {
        let u = Uint8Array::new(&blobs.get(i));
        vecs.push(u.to_vec());
    }
    let (out, dropped) = merge_sst_bytes(&vecs, drop_tombstones, target_bytes as usize, codec(lz4))
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let runs = Array::new();
    for run in &out {
        runs.push(&Uint8Array::from(run.as_slice()));
    }
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(&obj, &"ssts".into(), &runs)?;
    js_sys::Reflect::set(&obj, &"droppedSeq".into(), &JsValue::from_f64(dropped as f64))?;
    Ok(obj)
}
