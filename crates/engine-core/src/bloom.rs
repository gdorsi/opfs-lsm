//! Bloom filter matching `packages/kv/src/store/bloom.ts`.

use alloc::{vec, vec::Vec};

const FNV_OFFSET: u32 = 2166136261;
const FNV_PRIME: u32 = 16777619;

/// The one hash a key contributes to a filter: every probe derives from it,
/// so a writer can keep 4 bytes per key and build the filter at the end.
pub fn key_hash(data: &[u8]) -> u32 {
    let mut h = FNV_OFFSET;
    for &b in data {
        h ^= u32::from(b);
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

fn mix(mut h: u32) -> u32 {
    h ^= h >> 16;
    h = h.wrapping_mul(0x7feb_352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846c_a68b);
    h ^= h >> 16;
    h
}

#[derive(Debug, Clone)]
pub struct BloomFilter {
    pub bits: Vec<u8>,
    pub hash_count: u32,
}

pub fn bloom_params(key_count: usize, bits_per_key: usize) -> (usize, u32) {
    let n = key_count.max(1);
    let bit_count = (n * bits_per_key).max(64);
    let hash_count = ((bits_per_key as f64) * core::f64::consts::LN_2 + 0.5) as u32;
    (bit_count, hash_count.max(1))
}

pub fn create_bloom(key_count: usize, bits_per_key: usize) -> BloomFilter {
    let (bit_count, hash_count) = bloom_params(key_count, bits_per_key);
    BloomFilter {
        bits: vec![0u8; bit_count.div_ceil(8)],
        hash_count,
    }
}

fn bit_len(bits: &[u8]) -> usize {
    bits.len() * 8
}

fn set_bit(bits: &mut [u8], i: usize) {
    let idx = i >> 3;
    bits[idx] |= 1 << (i & 7);
}

fn get_bit(bits: &[u8], i: usize) -> bool {
    let idx = i >> 3;
    (bits[idx] & (1 << (i & 7))) != 0
}

fn bloom_index(h1: u32, h2: u32, i: u32, m: usize) -> usize {
    ((h1.wrapping_add(i.wrapping_mul(h2))) as usize) % m
}

pub fn bloom_add(filter: &mut BloomFilter, key: &[u8]) {
    bloom_add_hash(filter, key_hash(key));
}

/// `bloom_add` for a key whose `key_hash` is `h1`.
pub fn bloom_add_hash(filter: &mut BloomFilter, h1: u32) {
    let m = bit_len(&filter.bits);
    let h2 = mix(h1) | 1;
    for i in 0..filter.hash_count {
        set_bit(&mut filter.bits, bloom_index(h1, h2, i, m));
    }
}

/// The filter that `create_bloom(hashes.len(), bits_per_key)` and a
/// `bloom_add` of each key would build, from the keys' `key_hash`es.
pub fn bloom_from_hashes(hashes: &[u32], bits_per_key: usize) -> BloomFilter {
    let mut filter = create_bloom(hashes.len(), bits_per_key);
    for &h in hashes {
        bloom_add_hash(&mut filter, h);
    }
    filter
}

pub fn bloom_might_contain(filter: &BloomFilter, key: &[u8]) -> bool {
    let m = bit_len(&filter.bits);
    let h1 = key_hash(key);
    let h2 = mix(h1) | 1;
    for i in 0..filter.hash_count {
        if !get_bit(&filter.bits, bloom_index(h1, h2, i, m)) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hits_inserted() {
        let mut f = create_bloom(100, 10);
        bloom_add(&mut f, b"hello");
        assert!(bloom_might_contain(&f, b"hello"));
        assert!(!bloom_might_contain(&f, b"nope-key-xyz"));
    }

    #[test]
    fn a_filter_built_from_hashes_is_the_filter_built_from_keys() {
        for n in [0usize, 1, 2, 7, 64, 1000] {
            let keys: Vec<Vec<u8>> = (0..n).map(|i| format!("key/{i:06}").into_bytes()).collect();
            let mut by_key = create_bloom(keys.len(), 10);
            for k in &keys {
                bloom_add(&mut by_key, k);
            }
            let hashes: Vec<u32> = keys.iter().map(|k| key_hash(k)).collect();
            let by_hash = bloom_from_hashes(&hashes, 10);
            assert_eq!(by_hash.bits, by_key.bits, "{n} keys");
            assert_eq!(by_hash.hash_count, by_key.hash_count, "{n} keys");
        }
    }
}
