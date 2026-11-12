//! The mark table of range deletes, as the manifest encodes it
//! (crates/engine-abi.md, "Wire formats"): a step function over the key
//! space. Rust only reads it. TypeScript joins and retires marks, because it
//! reads the log and the manifest.

use crate::sst::read_u32;
use core::cmp::Ordering;

/// A marks block that `Marks::parse` accepted, without its piece count.
#[derive(Clone, Copy, Debug)]
pub struct Marks<'a> {
    pieces: &'a [u8],
}

/// A marks block that breaks the layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BadMarks;

/// Bytes of a piece past its start: u64 through, u64 at.
const SEQS: usize = 16;

impl<'a> Marks<'a> {
    /// The table with no mark.
    pub const NONE: Marks<'static> = Marks { pieces: &[] };

    /// Checks what reading needs: at least one piece, the first start
    /// empty, starts strictly increasing, nothing after the last piece.
    pub fn parse(block: &'a [u8]) -> Result<Marks<'a>, BadMarks> {
        if block.len() < 4 {
            return Err(BadMarks);
        }
        let count = read_u32(block, 0);
        let pieces = &block[4..];
        let mut o = 0;
        let mut prev: Option<&[u8]> = None;
        for _ in 0..count {
            let start = piece_start(pieces, o).ok_or(BadMarks)?;
            let ordered = match prev {
                None => start.is_empty(),
                Some(p) => p < start,
            };
            if !ordered || pieces.len() - (o + 4 + start.len()) < SEQS {
                return Err(BadMarks);
            }
            o += 4 + start.len() + SEQS;
            prev = Some(start);
        }
        if count == 0 || o != pieces.len() {
            return Err(BadMarks);
        }
        Ok(Marks { pieces })
    }

    pub(crate) fn bytes(&self) -> &'a [u8] {
        self.pieces
    }

    /// Marks over bytes a `parse` accepted earlier.
    pub(crate) fn trusted(pieces: &'a [u8]) -> Marks<'a> {
        Marks { pieces }
    }
}

fn piece_start(pieces: &[u8], o: usize) -> Option<&[u8]> {
    if pieces.len().checked_sub(o)? < 4 {
        return None;
    }
    let len = read_u32(pieces, o) as usize;
    pieces.get(o + 4..o + 4 + len)
}

/// The highest `through` covering keys that never decrease between calls.
/// Amortized O(1) per call. Holds offsets, not the bytes, so a merge session
/// can keep it beside the table it owns.
#[derive(Default)]
pub struct MarkCursor {
    /// The next piece not yet entered.
    next: usize,
    through: u64,
}

impl MarkCursor {
    /// `through` at the key `prefix` followed by `suffix`.
    pub fn at(&mut self, marks: Marks<'_>, prefix: &[u8], suffix: &[u8]) -> u64 {
        let pieces = marks.pieces;
        while self.next < pieces.len() {
            let len = read_u32(pieces, self.next) as usize;
            let start = &pieces[self.next + 4..self.next + 4 + len];
            if cmp_split(start, prefix, suffix) == Ordering::Greater {
                break;
            }
            let o = self.next + 4 + len;
            self.through = u64::from_le_bytes(pieces[o..o + 8].try_into().unwrap());
            self.next = o + SEQS;
        }
        self.through
    }
}

/// Whether a mark of `through` covers a version written at `seq`. Seqs start
/// at 1, and a through of 0 is no mark.
pub(crate) fn covers(through: u64, seq: u64) -> bool {
    through > 0 && seq <= through
}

/// `a` against the key `prefix` followed by `suffix`, without joining them.
fn cmp_split(a: &[u8], prefix: &[u8], suffix: &[u8]) -> Ordering {
    let n = a.len().min(prefix.len());
    match a[..n].cmp(&prefix[..n]) {
        Ordering::Equal if a.len() <= prefix.len() => a.len().cmp(&(prefix.len() + suffix.len())),
        Ordering::Equal => a[n..].cmp(suffix),
        other => other,
    }
}

/// The block of `pieces` (start, through, at), as the manifest writes it.
#[cfg(test)]
pub(crate) fn block(pieces: &[(&[u8], u64, u64)]) -> alloc::vec::Vec<u8> {
    let mut out = (pieces.len() as u32).to_le_bytes().to_vec();
    for (start, through, at) in pieces {
        out.extend_from_slice(&(start.len() as u32).to_le_bytes());
        out.extend_from_slice(start);
        out.extend_from_slice(&through.to_le_bytes());
        out.extend_from_slice(&at.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    #[test]
    fn a_cursor_reads_the_piece_of_each_key() {
        let b = block(&[(b"", 0, 0), (b"b", 5, 6), (b"bb", 0, 0), (b"d", 9, 10)]);
        let marks = Marks::parse(&b).unwrap();
        let mut c = MarkCursor::default();
        let keys: [(&[u8], &[u8], u64); 8] = [
            (b"", b"", 0),
            (b"a", b"zz", 0),
            (b"", b"b", 5),
            (b"b", b"a", 5),
            (b"b", b"b", 0),
            (b"c", b"", 0),
            (b"d", b"", 9),
            (b"zz", b"z", 9),
        ];
        for (prefix, suffix, want) in keys {
            assert_eq!(c.at(marks, prefix, suffix), want, "{prefix:?}+{suffix:?}");
        }
        assert_eq!(MarkCursor::default().at(Marks::NONE, b"k", b""), 0);
    }

    #[test]
    fn compares_a_split_key_as_one() {
        let keys: [&[u8]; 7] = [b"", b"a", b"ab", b"abc", b"abd", b"b", b"abcd"];
        for a in keys {
            for k in keys {
                for cut in 0..=k.len() {
                    assert_eq!(cmp_split(a, &k[..cut], &k[cut..]), a.cmp(k), "{a:?} vs {k:?} cut {cut}");
                }
            }
        }
    }

    #[test]
    fn refuses_a_block_that_breaks_the_layout() {
        let good = block(&[(b"", 0, 0), (b"m", 3, 4)]);
        assert!(Marks::parse(&good).is_ok());
        let bad = [
            Vec::new(),
            0u32.to_le_bytes().to_vec(),
            block(&[(b"a", 3, 4)]),
            block(&[(b"", 0, 0), (b"m", 3, 4), (b"m", 0, 0)]),
            block(&[(b"", 0, 0), (b"m", 3, 4), (b"c", 0, 0)]),
            good[..good.len() - 1].to_vec(),
            [good.as_slice(), &[0]].concat(),
        ];
        for b in bad {
            assert_eq!(Marks::parse(&b).err(), Some(BadMarks), "{b:?}");
        }
    }
}
