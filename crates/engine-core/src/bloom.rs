//! Bloom filter matching `packages/kv/src/store/bloom.ts`.

const FNV_OFFSET: u32 = 2166136261;
const FNV_PRIME: u32 = 16777619;

fn fnv1a(data: &[u8]) -> u32 {
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
    let hash_count = ((bits_per_key as f64) * std::f64::consts::LN_2).round() as u32;
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
    let m = bit_len(&filter.bits);
    let h1 = fnv1a(key);
    let h2 = mix(h1) | 1;
    for i in 0..filter.hash_count {
        set_bit(&mut filter.bits, bloom_index(h1, h2, i, m));
    }
}

pub fn bloom_might_contain(filter: &BloomFilter, key: &[u8]) -> bool {
    let m = bit_len(&filter.bits);
    let h1 = fnv1a(key);
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
}
