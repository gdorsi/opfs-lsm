//! CRC-32 (IEEE), matching packages/kv/src/store/crc32.ts

const fn tables() -> [[u32; 256]; 8] {
    let mut t = [[0u32; 256]; 8];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xedb88320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        t[0][i] = c;
        i += 1;
    }
    let mut s = 1;
    while s < 8 {
        let mut i = 0;
        while i < 256 {
            let prev = t[s - 1][i];
            t[s][i] = (prev >> 8) ^ t[0][(prev & 0xff) as usize];
            i += 1;
        }
        s += 1;
    }
    t
}

static T: [[u32; 256]; 8] = tables();

#[inline(always)]
fn step8(c: u32, x: &[u8]) -> u32 {
    let lo = u32::from_le_bytes([x[0], x[1], x[2], x[3]]) ^ c;
    let hi = u32::from_le_bytes([x[4], x[5], x[6], x[7]]);
    T[7][(lo & 0xff) as usize]
        ^ T[6][((lo >> 8) & 0xff) as usize]
        ^ T[5][((lo >> 16) & 0xff) as usize]
        ^ T[4][(lo >> 24) as usize]
        ^ T[3][(hi & 0xff) as usize]
        ^ T[2][((hi >> 8) & 0xff) as usize]
        ^ T[1][((hi >> 16) & 0xff) as usize]
        ^ T[0][(hi >> 24) as usize]
}

/// Running CRC state over `data`, slicing-by-8.
fn update(mut c: u32, data: &[u8]) -> u32 {
    let mut chunks = data.chunks_exact(8);
    for ch in &mut chunks {
        c = step8(c, ch);
    }
    for &b in chunks.remainder() {
        c = T[0][((c ^ u32::from(b)) & 0xff) as usize] ^ (c >> 8);
    }
    c
}

fn gf2_times(mat: &[u32; 32], mut vec: u32) -> u32 {
    let mut sum = 0;
    let mut i = 0;
    while vec != 0 {
        if vec & 1 != 0 {
            sum ^= mat[i];
        }
        vec >>= 1;
        i += 1;
    }
    sum
}

fn gf2_square(square: &mut [u32; 32], mat: &[u32; 32]) {
    for (out, &m) in square.iter_mut().zip(mat) {
        *out = gf2_times(mat, m);
    }
}

/// The CRC of `a ++ b` from `crc(a)`, `crc(b)`, and `b.len()`, as zlib's `crc32_combine`.
fn combine(mut crc_a: u32, crc_b: u32, mut len_b: usize) -> u32 {
    if len_b == 0 {
        return crc_a;
    }
    let mut even = [0u32; 32];
    let mut odd = [0u32; 32];
    odd[0] = 0xedb88320;
    let mut row = 1u32;
    for slot in odd.iter_mut().skip(1) {
        *slot = row;
        row <<= 1;
    }
    gf2_square(&mut even, &odd);
    gf2_square(&mut odd, &even);
    loop {
        gf2_square(&mut even, &odd);
        if len_b & 1 != 0 {
            crc_a = gf2_times(&even, crc_a);
        }
        len_b >>= 1;
        if len_b == 0 {
            break;
        }
        gf2_square(&mut odd, &even);
        if len_b & 1 != 0 {
            crc_a = gf2_times(&odd, crc_a);
        }
        len_b >>= 1;
        if len_b == 0 {
            break;
        }
    }
    crc_a ^ crc_b
}

/// Below this, combining streams costs more than it saves.
const STREAM_MIN: usize = 1024;

/// Slicing-by-8 over four quarters of `data` at once. The four lookup chains
/// don't depend on each other, so the CPU overlaps them.
pub fn crc32(data: &[u8]) -> u32 {
    if data.len() < STREAM_MIN {
        return update(0xffff_ffff, data) ^ 0xffff_ffff;
    }
    let q = (data.len() / 4) & !7;
    let (a, rest) = data.split_at(q);
    let (b, rest) = rest.split_at(q);
    let (c, d) = rest.split_at(q);
    let (mut ca, mut cb, mut cc, mut cd) = (!0u32, !0u32, !0u32, !0u32);
    for i in (0..q).step_by(8) {
        ca = step8(ca, &a[i..i + 8]);
        cb = step8(cb, &b[i..i + 8]);
        cc = step8(cc, &c[i..i + 8]);
        cd = step8(cd, &d[i..i + 8]);
    }
    let cd = update(cd, &d[q..]);
    let ab = combine(!ca, !cb, q);
    let abc = combine(ab, !cc, q);
    combine(abc, !cd, d.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytewise(data: &[u8]) -> u32 {
        let mut c = 0xffff_ffffu32;
        for &b in data {
            c = T[0][((c ^ u32::from(b)) & 0xff) as usize] ^ (c >> 8);
        }
        c ^ 0xffff_ffff
    }

    #[test]
    fn empty() {
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn check_value() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn matches_bytewise_across_the_stream_split() {
        let data: Vec<u8> = (0..70_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 11) as u8).collect();
        for len in (STREAM_MIN - 40..STREAM_MIN + 4000).chain([65_536, 69_993]) {
            for start in [0, 3] {
                let s = &data[start..start + len];
                assert_eq!(crc32(s), bytewise(s), "start {start} len {len}");
            }
        }
    }

    #[test]
    fn matches_bytewise_at_every_length_and_offset() {
        let data: Vec<u8> = (0..1100u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
        for start in 0..8 {
            for len in 0..1024 {
                let s = &data[start..start + len];
                assert_eq!(crc32(s), bytewise(s), "start {start} len {len}");
            }
        }
    }
}
