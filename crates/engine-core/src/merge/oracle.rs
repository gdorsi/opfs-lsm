//! The whole-buffer merge the session replaced, kept as the oracle the
//! session is tested against: same sources, same bytes, same dropped seq. Do
//! not change it to follow the session. A change to the merge rules changes
//! both on purpose.
//!
//! It takes one SST per source. A test gives a source of several runs as one
//! SST of their entries in order.

use crate::sst::{decode_sst, entry_size, Codec, EncodedRun, Entry, SstError, SstWriter};
use alloc::vec::Vec;
use core::mem;

struct Head {
    entry: Entry,
    run: usize,
}

fn before(a: &Head, b: &Head) -> bool {
    (a.entry.key(), a.run) < (b.entry.key(), b.run)
}

struct Heads(Vec<Head>);

impl Heads {
    fn top(&self) -> Option<&Head> {
        self.0.first()
    }

    fn push(&mut self, h: Head) {
        let v = &mut self.0;
        v.push(h);
        let mut i = v.len() - 1;
        while i > 0 && before(&v[i], &v[(i - 1) / 2]) {
            v.swap(i, (i - 1) / 2);
            i = (i - 1) / 2;
        }
    }

    fn replace_top(&mut self, next: Option<Head>) -> Head {
        let v = &mut self.0;
        let old = match next {
            Some(h) => mem::replace(&mut v[0], h),
            None => v.swap_remove(0),
        };
        let mut i = 0;
        loop {
            let mut m = i;
            for c in [2 * i + 1, 2 * i + 2] {
                if c < v.len() && before(&v[c], &v[m]) {
                    m = c;
                }
            }
            if m == i {
                return old;
            }
            v.swap(i, m);
            i = m;
        }
    }
}

pub(crate) fn merge_sst_bytes(
    sst_bytes: &[Vec<u8>],
    drop_tombstones: bool,
    target_bytes: usize,
    codec: Codec,
) -> Result<(Vec<EncodedRun>, u64), SstError> {
    let mut inputs = sst_bytes
        .iter()
        .map(|bytes| decode_sst(bytes).map(Vec::into_iter))
        .collect::<Result<Vec<_>, _>>()?;
    let mut heap = Heads(Vec::with_capacity(inputs.len()));
    for (run, input) in inputs.iter_mut().enumerate() {
        if let Some(entry) = input.next() {
            heap.push(Head { entry, run });
        }
    }

    let mut dropped = 0u64;
    let mut runs = Vec::new();
    let mut writer = SstWriter::new(codec);
    let mut bytes = Vec::new();
    let mut size = 0;
    while let Some(&Head { run, .. }) = heap.top() {
        let mut entry = None;
        let next_after = loop {
            match inputs[run].next() {
                Some(next) if next.key() == heap.top().unwrap().entry.key() => entry = Some(next),
                other => break other,
            }
        };
        let Head { entry: first, .. } = heap.replace_top(next_after.map(|entry| Head { entry, run }));
        let entry = entry.unwrap_or(first);
        while let Some(shadowed) = heap.top() {
            if shadowed.entry.key() != entry.key() {
                break;
            }
            let shadowed_run = shadowed.run;
            let replacement = loop {
                match inputs[shadowed_run].next() {
                    Some(next) if next.key() == entry.key() => continue,
                    other => break other,
                }
            };
            heap.replace_top(replacement.map(|entry| Head { entry, run: shadowed_run }));
        }
        if drop_tombstones && matches!(entry, Entry::Del { .. }) {
            dropped = dropped.max(entry.seq());
            continue;
        }
        size += entry_size((&entry).into());
        writer.push((&entry).into(), &mut bytes)?;
        if size >= target_bytes {
            let end = writer.finish(&mut bytes);
            runs.push(EncodedRun { bytes: mem::take(&mut bytes), end });
            size = 0;
        }
    }
    if !writer.is_empty() {
        let end = writer.finish(&mut bytes);
        runs.push(EncodedRun { bytes, end });
    }
    Ok((runs, dropped))
}
