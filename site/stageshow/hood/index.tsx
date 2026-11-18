import { ZapOff } from "lucide-react";
import type { ReactNode } from "react";
import { CHAPTERS } from "../../.vitepress/theme/figures.ts";
import { Avatar, Badge, Bar, Button, Collapse, Connector, Fly, Menu, Meter, Popover, Roll, Row, States, Text, Window, type Rect } from "../kit";
import { isDev } from "../kit/util";
import { ACCENT, tokens, type SceneTheme } from "../look.ts";
import { FULL_COMPACT_BELOW, SIZES } from "../sizes.ts";
import { Chapters, type Beat, type PlayerProps } from "../chapters.tsx";
import "./hood.css";

// The engine shown through the app the reader met in the hero, in chapters. Two tabs of LinearLite sit above a cut
// line; under it, the hood: the write-ahead log in IndexedDB, the SharedWorker and the SST files in OPFS. The page's
// player plays the chapters in a loop; each plays its beat and lands on its frame (`FRAMES[n]`, `BEATS[n]`, the text
// and length `CHAPTERS.hood[n]`):
//   0. Both tabs open the same database.
//   1. In tab 1 the cursor opens an issue's status menu and picks Done. "put": the tab appends record 43 to the log
//      itself; the committed row is the ack, marked "saved".
//   2. "BroadcastChannel": tab 1 tells tab 2, whose same issue turns Done in place.
//   3. The SharedWorker folds the log into a new file, l0/41-43.sst, and the log's rows leave it. The SharedWorker's
//      note changes from "a single instance for all the tabs" to the claim: it is the only code that writes files.
//   4. Tab 2 reads an older issue from l1/c7.0.sst, a compacted file of many pages. One 32 KB page lights up and
//      flies into the tab's page cache, and the issue's placeholder row turns into the real row. No message goes to
//      the SharedWorker: a tab reads files itself.
//   5. Tab 1 sets a second issue to In Progress. Record 44 lands in the log, "saved", and tab 2 follows. Then the
//      power goes out: the scene dims under a "Power lost" mark.
//   6. The reopen. Record 44 is gone and shown as lost, the second issue is Todo again in both tabs, the first is
//      still Done, the file is still listed, and the cache is empty, because reopening reads only the file list and
//      the log.
// Simplifications, each drawn the way it reads:
//   - The flush runs after one write. The engine waits for the log to reach `maxWalBytes`.
//   - The log's rows leave it with the flush that folded them. The engine keeps them until the next flush, as a
//     recovery copy no read uses.
//   - Chapter 4 shows one get. An app query reads index entries and documents, so it loads several pages.
//   - Chapter 6 shows one legal outcome of a power loss. A loss could also take record 43 and earlier writes that no
//     flush had reached, but never a write without the ones after it.
//   - The cache meter's fill is drawn wider than 32 KB of 256 MiB, so it can be seen. A reopened tab has an empty
//     cache, so its older issue is a placeholder row again until the tab reads it.
//   - Narrow, an open status menu draws past tab 1's window onto tab 2. A real menu stays inside its window.
// Wide, tab 1 leads, since the click is there, and tab 2 lies over its right edge. Both run under the hood's band, which
// is the cut. Narrow, no window covers another: tab 1 runs across the top, tab 2 sits under its right side, and the
// hood follows. The lane left of tab 2 is free, so "put" drops down it from tab 1.

type Props = PlayerProps & { readonly theme: SceneTheme };

const { wide: WIDE, compact: COMPACT } = SIZES.hood;

/**
 * Everything the scene shows. `menu`: which status menu is open in tab 1. `done1` and `done2`: the first issue is
 * Done in each tab. `prog1` and `prog2`: the second issue is In Progress in each tab. `put`, `bc`, `bc2`, `flush`
 * and `flush2`: which connectors are drawn. `rec`: record 43 is in the log. `cleared`: the log's rows have left it.
 * `file`: the new SST file is listed. `rec44`: record 44 is not there, saved, or lost. `read`: the page read of
 * chapter 4, from nothing to the page lit in its file, in flight, and landed. `cache`: what tab 2's page cache holds in KB,
 * or null while its meter is not shown. `off`: the power is out.
 */
type S = {
  menu: "none" | "focus" | "second";
  done1: boolean;
  done2: boolean;
  prog1: boolean;
  prog2: boolean;
  put: boolean;
  rec: boolean;
  bc: boolean;
  bc2: boolean;
  flush: boolean;
  flush2: boolean;
  file: boolean;
  cleared: boolean;
  rec44: "none" | "saved" | "lost";
  read: "none" | "lit" | "flying" | "done";
  cache: 0 | 32 | null;
  off: boolean;
};

const F0: S = {
  menu: "none",
  done1: false,
  done2: false,
  prog1: false,
  prog2: false,
  put: false,
  rec: false,
  bc: false,
  bc2: false,
  flush: false,
  flush2: false,
  file: false,
  cleared: false,
  rec44: "none",
  read: "none",
  cache: null,
  off: false,
};
const F1: S = { ...F0, done1: true, put: true, rec: true };
const F2: S = { ...F1, put: false, bc: true, done2: true };
const F3: S = { ...F2, bc: false, flush: true, flush2: true, file: true, cleared: true };
const F4: S = { ...F3, flush: false, flush2: false, read: "done", cache: 32 };
const F5: S = { ...F4, prog1: true, prog2: true, put: true, bc2: true, rec44: "saved", off: true };
const F6: S = { ...F5, put: false, bc2: false, prog1: false, prog2: false, rec44: "lost", read: "none", cache: 0, off: false };

/** The whole scene at the end of each chapter, aligned with `CHAPTERS.hood`. */
const FRAMES: S[] = [F0, F1, F2, F3, F4, F5, F6];

const pick: Beat<S> = async (a) => {
  await a.wait(150);
  a.mark("pick");
  await a.click({ at: "status-focus", x: 0.5, y: 0.55 });
  a.put({ menu: "focus" });
  await a.wait(500);
  await a.click({ at: "menu-done", x: 0.72, y: 0.55 });
  a.put({ menu: "none", done1: true });
  await a.wait(250);
  a.mark("put");
  a.put({ put: true });
  void a.move("rest");
  await a.wait(850);
  a.put({ rec: true });
  await a.wait(300);
};

const broadcast: Beat<S> = async (a) => {
  a.put({ put: false });
  await a.wait(250);
  a.mark("broadcast");
  a.put({ bc: true });
  await a.wait(1250);
  a.put({ done2: true });
  await a.wait(500);
};

const flush: Beat<S> = async (a) => {
  a.put({ bc: false });
  await a.wait(250);
  a.mark("flush");
  a.put({ flush: true });
  await a.wait(750);
  a.put({ flush2: true });
  await a.wait(750);
  a.put({ file: true });
  await a.wait(900);
  a.mark("cleared");
  a.put({ cleared: true });
  await a.wait(600);
};

const read: Beat<S> = async (a) => {
  a.put({ flush: false, flush2: false });
  await a.wait(300);
  a.mark("page");
  a.put({ read: "lit", cache: 0 });
  await a.wait(900);
  a.mark("get");
  a.put({ read: "flying" });
  await a.wait(540);
  a.put({ cache: 32 });
  await a.wait(240);
  a.mark("landed");
  a.put({ read: "done" });
  await a.wait(700);
};

const powerLoss: Beat<S> = async (a) => {
  await a.wait(150);
  a.mark("second");
  await a.click({ at: "status-second", x: 0.5, y: 0.55 });
  a.put({ menu: "second" });
  await a.wait(500);
  await a.click({ at: "menu-progress", x: 0.72, y: 0.55 });
  a.put({ menu: "none", prog1: true });
  await a.wait(250);
  a.mark("put2");
  a.put({ put: true });
  void a.move("rest");
  await a.wait(850);
  a.put({ rec44: "saved" });
  await a.wait(500);
  a.mark("broadcast2");
  a.put({ bc2: true });
  await a.wait(1250);
  a.put({ prog2: true });
  await a.wait(800);
  a.mark("power");
  a.put({ off: true });
  await a.wait(900);
};

const reopen: Beat<S> = async (a) => {
  a.mark("reopen");
  a.put({ off: false });
  await a.wait(800);
  a.put({ put: false, bc2: false, rec44: "lost" });
  await a.wait(800);
  a.put({ prog1: false });
  await a.wait(250);
  a.put({ prog2: false });
  await a.wait(600);
  a.put({ read: "none", cache: 0 });
  await a.wait(600);
};

/** The beat each chapter plays; chapter 0 is where the story starts, held for reading. */
const BEATS: readonly (Beat<S> | undefined)[] = [undefined, pick, broadcast, flush, read, powerLoss, reopen];

const MS = (CHAPTERS.hood ?? []).map((c) => c.ms);

if (isDev() && (FRAMES.length !== MS.length || BEATS.length !== FRAMES.length)) {
  throw new Error(`hood: ${FRAMES.length} frames and ${BEATS.length} beats, but ${MS.length} chapters in CHAPTERS.hood`);
}

// LinearLite's own status and priority glyphs (examples/linearlite-docstore/src/icons.tsx), 14px.
const Glyph = ({ children }: { children: ReactNode }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    {children}
  </svg>
);
const Ring = () => <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />;
const STATUS_GLYPHS = [
  <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2.2" />,
  <Ring />,
  <>
    <Ring />
    <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
  </>,
  <>
    <circle cx="7" cy="7" r="6.25" fill="currentColor" />
    <path d="M4.3 7.2l1.9 1.9 3.5-3.7" stroke="var(--ll-bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </>,
  <>
    <Ring />
    <path d="M5 5l4 4M9 5l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </>,
];
const STATUS_LABELS = ["Backlog", "Todo", "In Progress", "Done", "Canceled"];

const StatusGlyph = ({ code }: { code: number }) => (
  <span className="hd-glyph" data-st={code}>
    <Glyph>{STATUS_GLYPHS[code]}</Glyph>
  </span>
);

/** One mark that is Todo, In Progress or Done: the half fills in sideways, or the ring fills into the disc and the tick draws. */
const StatusMorph = ({ code }: { code: 1 | 2 | 3 }) => (
  <span className="hd-glyph hd-morph" data-st={code}>
    <Glyph>
      <circle className="hd-morph__ring" cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
      <path className="hd-morph__half" d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
      <circle className="hd-morph__disc" cx="7" cy="7" r="6.25" fill="currentColor" />
      <path className="hd-morph__tick" d="M4.3 7.2l1.9 1.9 3.5-3.7" stroke="var(--ll-bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
    </Glyph>
  </span>
);

const PRIORITY_BARS = [3, 3, 2, 1, 0];
const Priority = ({ code }: { code: number }) => (
  <span className="hd-glyph hd-prio hd-btn">
    <Glyph>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={1.5 + i * 4} y={9 - i * 3} width="2.6" height={3.5 + i * 3} rx="0.8" fill="currentColor" opacity={i < PRIORITY_BARS[code]! ? 1 : 0.28} />
      ))}
    </Glyph>
  </span>
);

type Issue = { id: string; title: string; who: string; date: string; status: number; priority: number };

// The issues the story is about: the first, which turns Done, the second, which turns In Progress and is lost again,
// one more recent issue, and an older one that tab 2 reads from a file. Everything else is placeholder.
const FOCUS: Issue = { id: "LL-2A91F", title: "Keep filters across views", who: "Maya Chen", date: "Nov 12", status: 1, priority: 1 };
const SECOND: Issue = { id: "LL-0B7E2", title: "Add a shortcut to assign to me", who: "Ana Ruiz", date: "Nov 11", status: 1, priority: 3 };
const SORT: Issue = { id: "LL-1F0C3", title: "Sort menu clips on small screens", who: "Jon Park", date: "Nov 9", status: 2, priority: 2 };
const OLDER: Issue = { id: "LL-07B13", title: "Export the current view as CSV", who: "Leo Sato", date: "Sep 2", status: 3, priority: 1 };
const FILLER = [150, 112, 136];

/**
 * What a tab shows of a row. Tab 1 leads, and tab 2 lies over its right end, so tab 1 draws nothing there. Tab 2 is
 * narrower, so it drops the id, as LinearLite does in a narrow window.
 */
type Cols = { id: boolean; trail: boolean; prio: boolean };

function IssueRow({ issue, lead, cols, target, titleTarget }: { issue: Issue; lead: ReactNode; cols: Cols; target?: string; titleTarget?: string }) {
  return (
    <Row
      pad={16}
      className="hd-row"
      data-target={target}
      lead={
        <span className="hd-lead">
          {cols.prio && <Priority code={issue.priority} />}
          {cols.id && <span className="hd-id">{issue.id}</span>}
          {lead}
        </span>
      }
      title={
        <Text className="hd-name" data-target={titleTarget}>
          {issue.title}
        </Text>
      }
    >
      {cols.trail && (
        <span className="hd-trail">
          <Avatar name={issue.who} size={20} />
          <span className="hd-date">{issue.date}</span>
        </span>
      )}
    </Row>
  );
}

function FillerRow({ w, cols }: { w: number; cols: Cols }) {
  return (
    <Row
      pad={16}
      className="hd-row"
      lead={
        <span className="hd-lead">
          {cols.prio && <span className="hd-btn"><Bar w={14} h={7} r={3.5} tone={1} /></span>}
          {cols.id && <Bar w={56} h={7} r={3.5} tone={1} />}
          <span className="hd-btn"><Bar w={14} h={7} r={3.5} tone={1} /></span>
        </span>
      }
      title={<Bar w={w} h={7} r={3.5} tone={2} />}
    >
      {cols.trail && (
        <span className="hd-trail">
          <Bar w={20} h={7} r={3.5} tone={1} />
          <Bar w={40} h={7} r={3.5} tone={1} />
        </span>
      )}
    </Row>
  );
}

/** A status button of the first or second issue. Tab 1's is what the cursor presses, and it keeps its pressed look while its menu is open. */
function StatusButton({ n, row, code, open }: { n: 1 | 2; row: "focus" | "second"; code: 1 | 2 | 3; open: boolean }) {
  return (
    <span className="hd-status" data-target={n === 1 ? `status-${row}` : undefined} data-cursor={n === 1 ? "hand" : undefined} data-open={open || undefined}>
      <StatusMorph code={code} />
    </span>
  );
}

/** One tab of LinearLite: the list pane, as the hero shows it, without its sidebar. */
function Tab({ n, s, compact }: { n: 1 | 2; s: S; compact: boolean }) {
  const done = n === 1 ? s.done1 : s.done2;
  const prog = n === 1 ? s.prog1 : s.prog2;
  const cols: Cols = n === 1 ? { id: !compact, trail: false, prio: true } : { id: false, trail: !compact, prio: !compact };
  const filler = compact ? [] : n === 1 ? FILLER : FILLER.slice(1, 2);
  return (
    <Window url={`LinearLite · Tab ${n}`} className={`hd-win hd-win--${n}`} data-target={`tab-${n}`}>
      <div className="hd-app">
        <div className="hd-bar">
          <span className="hd-title">All issues</span>
          <span className="hd-count">100,000</span>
          {n === 2 && !compact && (
            <Button size="small" variant="primary" className="hd-new">
              New issue
            </Button>
          )}
        </div>
        <IssueRow
          issue={FOCUS}
          cols={cols}
          target={`row-focus-${n}`}
          titleTarget={`title-focus-${n}`}
          lead={<StatusButton n={n} row="focus" code={done ? 3 : 1} open={n === 1 && s.menu === "focus"} />}
        />
        <IssueRow
          issue={SECOND}
          cols={cols}
          target={`row-second-${n}`}
          titleTarget={`title-second-${n}`}
          lead={<StatusButton n={n} row="second" code={prog ? 2 : 1} open={n === 1 && s.menu === "second"} />}
        />
        {!compact && <IssueRow issue={SORT} cols={cols} lead={<span className="hd-status"><StatusGlyph code={SORT.status} /></span>} />}
        {n === 2 && (
          <div className="hd-swap" data-ready={s.cache === 32 || undefined}>
            <div className="hd-swap__ph">
              <FillerRow w={compact ? 110 : 150} cols={cols} />
            </div>
            <div className="hd-swap__real">
              <IssueRow issue={OLDER} cols={cols} lead={<span className="hd-status"><StatusGlyph code={OLDER.status} /></span>} />
            </div>
          </div>
        )}
        {filler.map((w, i) => (
          <FillerRow key={i} w={w} cols={cols} />
        ))}
      </div>
    </Window>
  );
}

const RECORDS = [
  { seq: 42, id: "LL-1F0C3" },
  { seq: 41, id: "LL-0B7E2" },
];

function OlderRecord({ w }: { w: number }) {
  return (
    <Row pad={14} className="hd-rec hd-older" lead={<Bar w={14} h={7} r={3.5} tone={1} />} title={<Bar w={w} h={7} r={3.5} tone={2} />}>
      <Bar w={54} h={18} r={9} tone={1} />
    </Row>
  );
}

function Record({ seq, id, lost }: { seq: number; id: string; lost?: boolean }) {
  return (
    <Row
      pad={14}
      className="hd-rec"
      data-lost={lost || undefined}
      lead={<span className="hd-seq">{seq}</span>}
      title={<Text className="hd-mono">{`put ${id}`}</Text>}
    >
      <Badge tone={lost ? "danger" : "success"} className="hd-badge">
        <Roll variant="fade">{lost ? "lost" : "saved"}</Roll>
      </Badge>
    </Row>
  );
}

const PAGES = 9;
/** Which of the compacted file's pages holds the older issue. */
const PAGE = 3;

/** The compacted file as a strip of 32 KB pages. Once tab 2 reads, one lights, and it stays marked as the page that was copied. */
function Pages({ read, compact }: { read: S["read"]; compact: boolean }) {
  const lit = read === "lit" || read === "flying";
  return (
    <span className="hd-pages" data-in={read !== "none" || undefined} aria-hidden="true">
      {Array.from({ length: compact ? PAGES - 2 : PAGES }, (_, i) => (
        <span key={i} className="hd-cell" data-target={i === PAGE ? "page" : undefined} data-state={i === PAGE ? (lit ? "lit" : read === "done" ? "taken" : undefined) : undefined} />
      ))}
    </span>
  );
}

function Engine({ s, compact }: { s: S; compact: boolean }) {
  return (
    <div className="hd-hood">
      <section className="hd-card" data-target="wal">
        <header className="hd-head">
          <Text className="hd-card-title">Write-ahead log</Text>
          <Text className="hd-where">IndexedDB, one row per write</Text>
        </header>
        {/* The card keeps its height as its rows leave, so the SharedWorker and the files never move. */}
        <div className="hd-rows">
          <Collapse open={s.rec44 !== "none"}>
            <Record seq={44} id={SECOND.id} lost={s.rec44 === "lost"} />
          </Collapse>
          <Collapse open={!s.cleared}>
            <Collapse open={s.rec}>
              <Record seq={43} id={FOCUS.id} />
            </Collapse>
            {RECORDS.map((r) => (
              <Record key={r.seq} seq={r.seq} id={r.id} />
            ))}
            {(compact ? [112] : [112, 96]).map((w, i) => (
              <OlderRecord key={i} w={w} />
            ))}
          </Collapse>
          <span className="hd-empty" data-in={(s.cleared && s.rec44 === "none") || undefined}>
            <Text>Empty. Records 41 to 43 are in a file.</Text>
          </span>
        </div>
      </section>

      <div className="hd-node-slot">
        <div className="hd-node" data-target="node">
          <span className="hd-node-name">SharedWorker</span>
          <States
            className="hd-node-note"
            value={s.flush || s.file ? "writer" : "shared"}
            states={{ shared: "a single instance for all the tabs", writer: "the only file writer" }}
          />
        </div>
      </div>

      <section className="hd-card" data-target="sst">
        <header className="hd-head">
          <Text className="hd-card-title">SST files</Text>
          <Text className="hd-where">OPFS, sorted, never rewritten</Text>
        </header>
        <Collapse open={s.file}>
          <Row pad={14} className="hd-rec" title={<Text className="hd-mono hd-fresh">l0/41-43.sst</Text>}>
            <span className="hd-size">41 to 43</span>
          </Row>
        </Collapse>
        {(compact ? ["l1/c7.0.sst"] : ["l0/36-40.sst", "l1/c7.0.sst"]).map((f) => (
          <Row key={f} pad={14} className="hd-rec" title={<Text className="hd-mono">{f}</Text>}>
            {f === "l1/c7.0.sst" && <Pages read={s.read} compact={compact} />}
          </Row>
        ))}
        {(compact ? [104] : [96, 120]).map((w, i) => (
          <Row key={i} pad={14} className="hd-rec" title={<Bar w={w} h={7} r={3.5} tone={2} />} />
        ))}
      </section>
    </div>
  );
}

const mid = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** The part of the meter the cache's 32 KB fills, as the meter draws it. */
const CACHE_FILL = 0.14;

export default function Hood({ theme, jump, playhead, onChapter }: Props) {
  return (
    <Chapters<S>
      jump={jump}
      playhead={playhead}
      onChapter={onChapter}
      frames={FRAMES}
      beats={BEATS}
      ms={MS}
      width={WIDE[0]}
      height={WIDE[1]}
      compact={{ below: FULL_COMPACT_BELOW, width: COMPACT[0], height: COMPACT[1] }}
      cursor={{ at: "rest" }}
      theme={theme}
      accent={ACCENT}
      tokens={tokens(theme)}
      className="hood"
    >
      {(s, rect, layout) => {
        const compact = layout === "compact";
        const tab1 = rect("tab-1");
        const tab2 = rect("tab-2");
        const status = { focus: rect("status-focus"), second: rect("status-second") };
        const focus1 = rect("row-focus-1");
        const focus2 = rect("row-focus-2");
        const focusTitle1 = rect("title-focus-1");
        const second1 = rect("row-second-1");
        const second2 = rect("row-second-2");
        const secondTitle1 = rect("title-second-1");
        const wal = rect("wal");
        const sst = rect("sst");
        const node = rect("node");
        const band = rect("band");
        const page = rect("page");
        const bar = rect("cache-bar");
        const ready = [tab1, tab2, status.focus, status.second, focus1, focus2, focusTitle1, second1, second2, secondTitle1, wal, sst, node, band, page, bar].every((r) => r.width > 0);
        // Narrow, tab 2 sits under tab 1's right side, so the put leaves tab 1's foot and drops down the free lane
        // left of tab 2: the tab that writes is the tab the arrow comes from.
        const putX = compact ? (wal.x + tab2.x) / 2 : wal.x + 64;
        const putFrom = compact ? tab1.y + tab1.height + 5 : band.y + 5;
        const n = mid(node);
        // Narrow, the broadcast drops from tab 1's foot onto tab 2's top edge, right of the lane the put uses.
        const bcX = (tab2.x + COMPACT[0]) / 2;
        // A status menu hangs under the status button it opens from.
        const menu = (which: "focus" | "second") => (
          <Popover
            show={s.menu === which}
            className="hd-menu"
            origin="top left"
            style={{ left: Math.round(status[which].x) - 4, top: Math.round(status[which].y + status[which].height) }}
          >
            <Menu
              items={STATUS_LABELS.map((label, code) => (
                <span key={label} className="hd-item" data-cursor="hand">
                  <StatusGlyph code={code} />
                  <span>{label}</span>
                  {code === 1 && (
                    <svg className="hd-tick" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M2.5 6.3l2.4 2.4 4.6-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
              ))}
              targets={which === "focus" ? [undefined, undefined, undefined, "menu-done", undefined] : [undefined, undefined, "menu-progress", undefined, undefined]}
            />
          </Popover>
        );
        // A broadcast from one issue's row in tab 1 to the same issue's row in tab 2.
        const broadcast = (show: boolean, from: Rect, fromRow: Rect, to: Rect) =>
          compact ? (
            <Connector show={show} route="straight" arrow label="BroadcastChannel" from={{ x: bcX, y: tab1.y + tab1.height + 5 }} to={{ x: bcX, y: tab2.y - 5 }} />
          ) : (
            <Connector show={show} route="step" arrow label="BroadcastChannel" labelAt={0.79} from={{ x: from.x + from.width + 12, y: mid(fromRow).y }} to={{ x: tab2.x - 5, y: mid(to).y }} />
          );
        const fill = { x: bar.x, y: bar.y, width: bar.width * CACHE_FILL, height: bar.height };
        return (
          <>
            <div className="hd-scene" data-off={s.off || undefined}>
              <Tab n={1} s={s} compact={compact} />
              <Tab n={2} s={s} compact={compact} />
              <span className="hd-rest" data-target="rest" />
              <div className="hd-band" data-target="band" />
              <Engine s={s} compact={compact} />
              <div className="hd-cache" data-in={s.cache !== null || undefined}>
                <span className="hd-cache__name">Cache</span>
                <Meter value={s.cache ? CACHE_FILL : 0} className="hd-cache__bar" data-target="cache-bar" />
                <span className="hd-cache__text">
                  <Roll>{`${s.cache ?? 0} KB`}</Roll> of 256 MiB
                </span>
              </div>
              {menu("focus")}
              {menu("second")}

              {ready && (
                <>
                  <Connector show={s.put} route="straight" arrow label="put" from={{ x: putX, y: putFrom }} to={{ x: putX, y: wal.y - 5 }} />
                  {broadcast(s.bc, focusTitle1, focus1, focus2)}
                  {broadcast(s.bc2, secondTitle1, second1, second2)}
                  {compact ? (
                    <>
                      <Connector show={s.flush} route="straight" from={{ x: n.x, y: wal.y + wal.height + 5 }} to={{ x: n.x, y: node.y - 5 }} dots="none" />
                      <Connector show={s.flush2} route="straight" arrow from={{ x: n.x, y: node.y + node.height + 5 }} to={{ x: n.x, y: sst.y - 5 }} />
                    </>
                  ) : (
                    <>
                      <Connector show={s.flush} route="straight" from={{ x: wal.x + wal.width + 5, y: n.y }} to={{ x: node.x - 5, y: n.y }} dots="none" />
                      <Connector show={s.flush2} route="straight" arrow from={{ x: node.x + node.width + 5, y: n.y }} to={{ x: sst.x - 5, y: n.y }} />
                    </>
                  )}
                  <Fly from={page} to={fill} go={s.read === "flying"} held={s.read === "lit"} duration={760} className="hd-fly">
                    <span className="hd-flyer" />
                  </Fly>
                </>
              )}
            </div>
            <div className="hd-power" data-on={s.off || undefined} aria-hidden="true">
              <Badge tone="danger" icon={<ZapOff size={16} strokeWidth={2} />}>
                Power lost
              </Badge>
            </div>
          </>
        );
      }}
    </Chapters>
  );
}
