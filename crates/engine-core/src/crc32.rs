//! CRC-32 (IEEE), matching packages/kv/src/store/crc32.ts

use core::sync::atomic::{AtomicBool, AtomicU32, Ordering};

/// Bytes in each of the four lanes `update` runs at once.
const LANE: usize = 64;

/// The slicing-by-8 tables, filled on first use. Zeroed statics take no
/// bytes in the module, where a const table would put 8 KiB in .rodata.
/// Racing fills store the same values, so a second filler is harmless.
static T: [[AtomicU32; 256]; 8] = [const { [const { AtomicU32::new(0) }; 256] }; 8];
/// What appending `LANE` zero bytes does to a CRC register, one table per
/// register byte. It carries a lane's result past the lanes after it.
static SHIFT: [[AtomicU32; 256]; 4] = [const { [const { AtomicU32::new(0) }; 256] }; 4];
static READY: AtomicBool = AtomicBool::new(false);

#[cold]
fn fill() {
    for (i, slot) in T[0].iter().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb88320 ^ (c >> 1) } else { c >> 1 };
        }
        slot.store(c, Ordering::Relaxed);
    }
    for s in 1..8 {
        let (done, row) = T.split_at(s);
        for (i, slot) in row[0].iter().enumerate() {
            let prev = done[s - 1][i].load(Ordering::Relaxed);
            slot.store((prev >> 8) ^ t(0, prev & 0xff), Ordering::Relaxed);
        }
    }
    // Appending zeros is linear, so its effect on a register is the XOR of
    // its effect on each bit.
    let mut bit = [0u32; 32];
    for (i, out) in bit.iter_mut().enumerate() {
        let mut r = 1u32 << i;
        for _ in 0..LANE {
            r = (r >> 8) ^ t(0, r & 0xff);
        }
        *out = r;
    }
    for (k, row) in SHIFT.iter().enumerate() {
        for (b, slot) in row.iter().enumerate() {
            let set = (0..8).filter(|j| b >> j & 1 != 0);
            slot.store(set.fold(0, |acc, j| acc ^ bit[8 * k + j]), Ordering::Relaxed);
        }
    }
    READY.store(true, Ordering::Release);
}

#[inline(always)]
fn t(s: usize, i: u32) -> u32 {
    T[s][i as usize].load(Ordering::Relaxed)
}

#[inline(always)]
fn step8(c: u32, x: &[u8]) -> u32 {
    let lo = u32::from_le_bytes([x[0], x[1], x[2], x[3]]) ^ c;
    let hi = u32::from_le_bytes([x[4], x[5], x[6], x[7]]);
    t(7, lo & 0xff)
        ^ t(6, (lo >> 8) & 0xff)
        ^ t(5, (lo >> 16) & 0xff)
        ^ t(4, lo >> 24)
        ^ t(3, hi & 0xff)
        ^ t(2, (hi >> 8) & 0xff)
        ^ t(1, (hi >> 16) & 0xff)
        ^ t(0, hi >> 24)
}

/// `r` after `LANE` zero bytes.
#[inline(always)]
fn shift(r: u32) -> u32 {
    let s = |k: usize, i: u32| SHIFT[k][i as usize].load(Ordering::Relaxed);
    s(0, r & 0xff) ^ s(1, (r >> 8) & 0xff) ^ s(2, (r >> 16) & 0xff) ^ s(3, r >> 24)
}

/// The register `c` after `data`, as slicing-by-8 computes it. It runs four
/// `LANE`-byte lanes at once: their lookup chains don't depend on each other,
/// so the CPU overlaps them, and `shift` joins the four results. A lane is
/// short so that a 4 KiB block gains from it.
fn update(mut c: u32, data: &[u8]) -> u32 {
    let mut quads = data.chunks_exact(4 * LANE);
    for quad in &mut quads {
        let (a, rest) = quad.split_at(LANE);
        let (b, rest) = rest.split_at(LANE);
        let (e, d) = rest.split_at(LANE);
        let (mut ra, mut rb, mut re, mut rd) = (c, 0, 0, 0);
        for i in (0..LANE).step_by(8) {
            ra = step8(ra, &a[i..i + 8]);
            rb = step8(rb, &b[i..i + 8]);
            re = step8(re, &e[i..i + 8]);
            rd = step8(rd, &d[i..i + 8]);
        }
        c = shift(shift(shift(ra) ^ rb) ^ re) ^ rd;
    }
    let mut words = quads.remainder().chunks_exact(8);
    for w in &mut words {
        c = step8(c, w);
    }
    for &b in words.remainder() {
        c = t(0, (c ^ u32::from(b)) & 0xff) ^ (c >> 8);
    }
    c
}

fn ensure_tables() {
    if !READY.load(Ordering::Acquire) {
        fill();
    }
}

/// A CRC over bytes that arrive in pieces, such as the blocks of a run.
pub(crate) struct Crc32(u32);

impl Crc32 {
    pub(crate) fn new() -> Self {
        ensure_tables();
        Crc32(!0)
    }

    pub(crate) fn update(&mut self, data: &[u8]) {
        self.0 = update(self.0, data);
    }

    pub(crate) fn value(&self) -> u32 {
        !self.0
    }

    pub(crate) fn reset(&mut self) {
        self.0 = !0;
    }
}

pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = Crc32::new();
    crc.update(data);
    crc.value()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytewise(data: &[u8]) -> u32 {
        let mut c = 0xffff_ffffu32;
        for &b in data {
            c = t(0, (c ^ u32::from(b)) & 0xff) ^ (c >> 8);
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
    fn matches_bytewise_across_the_lane_boundaries() {
        let data: Vec<u8> = (0..70_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 11) as u8).collect();
        let quad = 4 * LANE;
        for len in (quad - 9..3 * quad + 9).chain([4096, 4097, 65_536, 69_993]) {
            for start in [0, 3] {
                let s = &data[start..start + len];
                assert_eq!(crc32(s), bytewise(s), "start {start} len {len}");
            }
        }
    }

    #[test]
    fn pieces_give_the_crc_of_the_whole() {
        let data: Vec<u8> = (0..5000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 9) as u8).collect();
        let mut crc = Crc32::new();
        assert_eq!(crc.value(), 0, "no bytes");
        for cut in [0, 1, 7, 8, 9, 100, 255, 256, 257, 1023, 1024, 4097, 5000] {
            crc.reset();
            crc.update(&data[..cut]);
            crc.update(&data[cut..]);
            assert_eq!(crc.value(), crc32(&data), "cut at {cut}");
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
