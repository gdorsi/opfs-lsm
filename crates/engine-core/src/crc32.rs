//! CRC-32 (IEEE), matching packages/kv/src/store/crc32.ts

fn table() -> [u32; 256] {
    let mut t = [0u32; 256];
    for i in 0..256 {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xedb88320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
        t[i] = c;
    }
    t
}

pub fn crc32(data: &[u8]) -> u32 {
    let table = table();
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c = table[((c ^ u32::from(b)) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty() {
        assert_eq!(crc32(b""), 0);
    }
}
