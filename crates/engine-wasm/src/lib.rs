use engine_core::{decode_sst, encode_sst, merge_sst_bytes, Entry};
use js_sys::{Array, Uint8Array};
use wasm_bindgen::prelude::*;

/// Encode entries from JS: `[{kind:'put'|'del', key:Uint8Array, value?:Uint8Array, seq?:number}, ...]`
#[wasm_bindgen]
pub fn encode_sst_js(entries: Array) -> Result<Uint8Array, JsValue> {
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
    let bytes = encode_sst(&rust_entries);
    Ok(Uint8Array::from(bytes.as_slice()))
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
/// order. `drop_tombstones` is for a merge nothing older overlaps. Returns
/// `{ssts, droppedSeq}`, where droppedSeq is the highest seq of a dropped
/// tombstone, 0 when none.
#[wasm_bindgen]
pub fn merge_ssts_js(
    blobs: Array,
    drop_tombstones: bool,
    target_bytes: f64,
) -> Result<js_sys::Object, JsValue> {
    let mut vecs = Vec::with_capacity(blobs.length() as usize);
    for i in 0..blobs.length() {
        let u = Uint8Array::new(&blobs.get(i));
        vecs.push(u.to_vec());
    }
    let (out, dropped) = merge_sst_bytes(&vecs, drop_tombstones, target_bytes as usize)
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
