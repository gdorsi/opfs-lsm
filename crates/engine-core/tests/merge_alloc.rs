//! Once warm, a merge session allocates per output run, never per entry:
//! input windows, unpacked blocks, the two entry slots per source, the heap
//! and the output buffer keep their capacity. Counted on this thread only,
//! inside `pump` and `feed`.
//!
//! LZ4 output is the exception: lz4_flex 0.11 allocates its hash table for
//! every block it compresses, with no way to pass one in.

use engine_core::{encode_sst, Codec, Entry, Marks, MergeConfig, MergeSession, Stop};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;

static ALLOCS: AtomicUsize = AtomicUsize::new(0);

thread_local! {
    static COUNTING: Cell<bool> = const { Cell::new(false) };
}

fn count() {
    if COUNTING.try_with(Cell::get).unwrap_or(false) {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
    }
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count();
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count();
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count();
        unsafe { System.realloc(ptr, layout, new_size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn counted<T>(f: impl FnOnce() -> T) -> T {
    COUNTING.with(|c| c.set(true));
    let out = f();
    COUNTING.with(|c| c.set(false));
    out
}

/// Three overlapping sources over 30,000 keys of one shape, so slot sizes
/// settle on the first entries: every key, every second key, every third.
/// The middle source is three LZ4 runs; the others are one raw run each.
fn sources() -> (Vec<Vec<Vec<u8>>>, usize) {
    let entry = |i: usize, s: usize| Entry::Put { key: format!("key/{i:08}").into_bytes(), value: vec![s as u8; 48], seq: i as u64, expires_at: None };
    let newest: Vec<Entry> = (0..30_000).filter(|i| i % 3 == 0).map(|i| entry(i, 0)).collect();
    let middle: Vec<Entry> = (0..30_000).filter(|i| i % 2 == 0).map(|i| entry(i, 1)).collect();
    let oldest: Vec<Entry> = (0..30_000).map(|i| entry(i, 2)).collect();
    let thirds = middle.len() / 3;
    let sources = vec![
        vec![encode_sst(&newest, Codec::Raw)],
        middle.chunks(thirds).map(|run| encode_sst(run, Codec::Lz4)).collect(),
        vec![encode_sst(&oldest, Codec::Raw)],
    ];
    (sources, newest.len() + middle.len() + oldest.len())
}

/// A mark every 1,000 keys, each over the first 500 keys of its thousand
/// and the seqs up to 20,000, so the session walks 60 pieces as it merges.
fn marks() -> Vec<u8> {
    let mut pieces: Vec<(Vec<u8>, u64)> = vec![(Vec::new(), 0)];
    for k in (0..30_000).step_by(1_000) {
        pieces.push((format!("key/{k:08}").into_bytes(), 20_000));
        pieces.push((format!("key/{:08}", k + 500).into_bytes(), 0));
    }
    let mut out = (pieces.len() as u32).to_le_bytes().to_vec();
    for (start, through) in pieces {
        out.extend_from_slice(&(start.len() as u32).to_le_bytes());
        out.extend_from_slice(&start);
        out.extend_from_slice(&through.to_le_bytes());
        out.extend_from_slice(&(if through == 0 { 0u64 } else { 30_001 }).to_le_bytes());
    }
    out
}

struct Warm {
    allocs: usize,
    runs: usize,
    blocks: usize,
}

/// Drive to the end and count what `pump` and `feed` allocate after the
/// second output run, by when every buffer has met its largest input.
fn warm_allocations(codec: Codec) -> Warm {
    let (sources, _) = sources();
    let sizes: Vec<Vec<u32>> = sources.iter().map(|runs| runs.iter().map(|r| r.len() as u32).collect()).collect();
    let config = MergeConfig {
        drop_tombstones: false,
        judge_now: 0,
        target_bytes: 200 * 1024,
        codec,
        chunk_bytes: 64 * 1024,
        tail_bytes: 128 * 1024,
        yield_bytes: 1024 * 1024,
    };
    let marks = marks();
    let mut session = MergeSession::open(config, &sizes, Marks::parse(&marks).unwrap()).unwrap();
    let (mut ended, mut warm) = (0, Warm { allocs: 0, runs: 0, blocks: 0 });
    let mut run = Vec::new();
    loop {
        let before = ALLOCS.load(Ordering::Relaxed);
        let stop = counted(|| session.pump().unwrap());
        let mut allocs = ALLOCS.load(Ordering::Relaxed) - before;
        match stop {
            Stop::Need(demands) => {
                let demands = demands.to_vec();
                for d in demands {
                    let bytes = &sources[d.source as usize][d.run as usize][d.offset as usize..][..d.len as usize];
                    let before = ALLOCS.load(Ordering::Relaxed);
                    counted(|| session.feed(d.source as usize, bytes.len()).unwrap().copy_from_slice(bytes));
                    allocs += ALLOCS.load(Ordering::Relaxed) - before;
                }
            }
            Stop::Write(bytes) => run.extend_from_slice(bytes),
            Stop::RunEnd(_) => {
                ended += 1;
                if ended > 2 {
                    warm.runs += 1;
                    let footer = run.len() - 52;
                    warm.blocks += u32::from_le_bytes(run[footer + 4..footer + 8].try_into().unwrap()) as usize;
                }
                run.clear();
            }
            Stop::Yield => {}
            Stop::Done(_) => return warm,
        }
        if ended >= 2 {
            warm.allocs += allocs;
        }
    }
}

#[test]
fn a_warm_session_allocates_per_run_not_per_entry() {
    let (_, entries) = sources();
    let raw = warm_allocations(Codec::Raw);
    assert!(raw.runs >= 4, "{} warm runs", raw.runs);
    // `finish` builds the bloom filter and hands the run's first and last key
    // and a copy of its statistics to `RunEnd`, which the next run's first
    // push allocates again.
    assert!(raw.allocs <= 4 * raw.runs + 8, "{} allocations over {} warm runs of raw output", raw.allocs, raw.runs);
    assert!(raw.allocs * 100 < entries, "{} allocations for {entries} input entries", raw.allocs);

    let lz4 = warm_allocations(Codec::Lz4);
    assert!(lz4.allocs <= lz4.blocks + 4 * lz4.runs + 8, "{} allocations over {} warm runs, {} blocks of LZ4 output", lz4.allocs, lz4.runs, lz4.blocks);
    println!(
        "warm allocations: raw output {} over {} runs; LZ4 output {} over {} runs and {} blocks; {entries} input entries",
        raw.allocs, raw.runs, lz4.allocs, lz4.runs, lz4.blocks
    );
}
