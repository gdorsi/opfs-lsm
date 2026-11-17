import type { ReactNode } from "react";
import { Avatar, Badge, Bar, Button, Collapse, Connector, Menu, Popover, Row, Stage, Text, Window, type Act, type Rect } from "../kit";
import { ACCENT, tokens, type SceneTheme } from "../look.ts";
import { FULL_COMPACT_BELOW, SIZES } from "../sizes.ts";
import "./hood.css";

// The engine shown through the app the reader met in the hero. Two tabs of LinearLite sit above a cut line; under
// it, the hood: the write-ahead log in IndexedDB, the SharedWorker and the SST files in OPFS. One status change
// travels through all of it, in five beats, once:
//   1. In tab 1 the cursor opens an issue's status menu and picks Done.
//   2. "put": the tab appends record 43 to the log itself; the committed row is the ack, marked "saved".
//   3. "BroadcastChannel": tab 1 tells tab 2, whose same issue turns Done in place.
//   4. The SharedWorker folds the log into a new file, l0/41-43.sst.
//   5. The log's rows leave it: the file holds them now. The payoff holds: both tabs agree, the log is empty.
// The engine keeps the rows a flush folded until the next flush, as a recovery copy no read uses; the figure lets
// them go with the flush that folded them. It also flushes after one write, where the engine waits for the log to
// reach `maxWalBytes`.
// Tab 1, where the click is, leads; tab 2 lies over its right edge. Both run under the hood's band, which is the cut.

type Props = { readonly theme: SceneTheme };

const { wide: WIDE, compact: COMPACT } = SIZES.hood;

/** `file`: the new SST file is listed. `cleared`: the log's rows have left it. */
type S = {
  menu: boolean;
  done1: boolean;
  put: boolean;
  rec: boolean;
  bc: boolean;
  done2: boolean;
  flush: boolean;
  flush2: boolean;
  file: boolean;
  cleared: boolean;
};

const START: S = { menu: false, done1: false, put: false, rec: false, bc: false, done2: false, flush: false, flush2: false, file: false, cleared: false };
const END: S = { menu: false, done1: true, put: true, rec: true, bc: true, done2: true, flush: true, flush2: true, file: true, cleared: true };

async function script(a: Act<S>) {
  await a.wait(700);
  a.mark("pick");
  await a.click({ at: "status-1", x: 0.5, y: 0.55 });
  a.put({ menu: true });
  await a.wait(500);
  await a.click({ at: "menu-done", x: 0.72, y: 0.55 });
  a.put({ menu: false, done1: true });
  await a.wait(250);
  a.mark("put");
  a.put({ put: true });
  void a.move("rest");
  await a.wait(850);
  a.put({ rec: true });
  await a.wait(1200);
  a.mark("broadcast");
  a.put({ bc: true });
  await a.wait(1250);
  a.put({ done2: true });
  await a.wait(1400);
  a.mark("flush");
  a.put({ flush: true });
  await a.wait(750);
  a.put({ flush2: true });
  await a.wait(750);
  a.put({ file: true });
  await a.wait(900);
  a.mark("cleared");
  a.put({ cleared: true });
  await a.wait(2800);
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

/** Todo turning Done as one mark: the ring fills into the disc, then the tick draws. */
const StatusMorph = ({ done }: { done: boolean }) => (
  <span className="hd-glyph hd-morph" data-st={done ? 3 : 1}>
    <Glyph>
      <circle className="hd-morph__ring" cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
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

// The issue the story is about, then two real neighbors. Everything under them is placeholder.
const FOCUS: Issue = { id: "LL-2A91F", title: "Keep filters across views", who: "Maya Chen", date: "Nov 12", status: 1, priority: 1 };
const NEIGHBORS: Issue[] = [
  { id: "LL-1F0C3", title: "Sort menu clips on small screens", who: "Jon Park", date: "Nov 11", status: 2, priority: 2 },
  { id: "LL-0B7E2", title: "Add a shortcut to assign to me", who: "Ana Ruiz", date: "Nov 9", status: 1, priority: 3 },
];
const FILLER = [150, 112, 136, 96, 124];
const FILLER_NARROW = [120, 96];

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

/** One tab of LinearLite: the list pane, as the hero shows it, without its sidebar. */
function Tab({ n, done, neighbors, filler, cols, button, open }: { n: 1 | 2; done: boolean; neighbors: number; filler: readonly number[]; cols: Cols; button: boolean; open?: boolean }) {
  return (
    <Window url={`LinearLite · Tab ${n}`} className={`hd-win hd-win--${n}`} data-target={`tab-${n}`}>
      <div className="hd-app">
        <div className="hd-bar">
          <span className="hd-title">All issues</span>
          <span className="hd-count">100,000</span>
          {button && (
            <Button size="small" variant="primary" className="hd-new">
              New issue
            </Button>
          )}
        </div>
        <IssueRow
          issue={FOCUS}
          cols={cols}
          target={`row-${n}`}
          titleTarget={`title-${n}`}
          lead={
            <span className="hd-status" data-target={n === 1 ? "status-1" : undefined} data-cursor={n === 1 ? "hand" : undefined} data-open={open || undefined}>
              <StatusMorph done={done} />
            </span>
          }
        />
        {NEIGHBORS.slice(0, neighbors).map((issue) => (
          <IssueRow key={issue.id} issue={issue} cols={cols} lead={<span className="hd-status"><StatusGlyph code={issue.status} /></span>} />
        ))}
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

function Record({ seq, id }: { seq: number; id: string }) {
  return (
    <Row
      pad={14}
      className="hd-rec"
      lead={<span className="hd-seq">{seq}</span>}
      title={<Text className="hd-mono">{`put ${id}`}</Text>}
    >
      <Badge tone="success" className="hd-badge">
        saved
      </Badge>
    </Row>
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
          <span className="hd-empty" data-in={s.cleared || undefined}>
            <Text>Empty. Records 41 to 43 are in a file.</Text>
          </span>
        </div>
      </section>

      <div className="hd-node-slot">
        <div className="hd-node" data-target="node">
          <span className="hd-node-name">SharedWorker</span>
          <span className="hd-node-note">a single instance for all the tabs</span>
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
        {(compact ? ["l0/36-40.sst"] : ["l0/36-40.sst", "l1/c7.0.sst"]).map((f) => (
          <Row key={f} pad={14} className="hd-rec" title={<Text className="hd-mono">{f}</Text>} />
        ))}
        {(compact ? [104] : [96, 120]).map((w, i) => (
          <Row key={i} pad={14} className="hd-rec" title={<Bar w={w} h={7} r={3.5} tone={2} />} />
        ))}
      </section>
    </div>
  );
}

const mid = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

export default function Hood({ theme }: Props) {
  return (
    <Stage<S>
      width={WIDE[0]}
      height={WIDE[1]}
      compact={{ below: FULL_COMPACT_BELOW, width: COMPACT[0], height: COMPACT[1] }}
      initial={START}
      poster={END}
      script={script}
      play="once"
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
        const row2 = rect("row-2");
        const title1 = rect("title-1");
        const row1 = rect("row-1");
        const wal = rect("wal");
        const sst = rect("sst");
        const node = rect("node");
        const band = rect("band");
        const ready = [tab1, tab2, row2, title1, row1, wal, sst, node, band].every((r) => r.width > 0);
        const putX = compact ? wal.x + 32 : wal.x + 64;
        const putFrom = compact ? tab1.y + tab1.height + 5 : band.y + 5;
        const n = mid(node);
        const bcX = (tab2.x + COMPACT[0]) / 2;
        return (
          <>
            <Tab
              n={1}
              done={s.done1}
              neighbors={compact ? 0 : 2}
              filler={compact ? [] : FILLER.slice(0, 3)}
              cols={{ id: !compact, trail: false, prio: true }}
              button={false}
              open={s.menu}
            />
            <Tab
              n={2}
              done={s.done2}
              neighbors={compact ? 0 : 2}
              filler={compact ? FILLER_NARROW : FILLER.slice(0, 2)}
              cols={{ id: false, trail: !compact, prio: !compact }}
              button={!compact}
            />
            <span className="hd-rest" data-target="rest" />
            <div className="hd-band" data-target="band" />
            <Engine s={s} compact={compact} />
            <Popover show={s.menu} className="hd-menu" origin="top left">
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
                targets={[undefined, undefined, undefined, "menu-done", undefined]}
              />
            </Popover>

            {ready && (
              <>
                <Connector show={s.put} route="straight" arrow label="put" from={{ x: putX, y: putFrom }} to={{ x: putX, y: wal.y - 5 }} />
                {compact ? (
                  <Connector
                    show={s.bc}
                    route="straight"
                    arrow
                    label="BroadcastChannel"
                    from={{ x: bcX, y: tab1.y + tab1.height + 5 }}
                    to={{ x: bcX, y: tab2.y - 5 }}
                  />
                ) : (
                  <Connector
                    show={s.bc}
                    route="step"
                    arrow
                    label="BroadcastChannel"
                    labelAt={0.79}
                    from={{ x: title1.x + title1.width + 12, y: mid(row1).y }}
                    to={{ x: tab2.x - 5, y: mid(row2).y }}
                  />
                )}
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
              </>
            )}
          </>
        );
      }}
    </Stage>
  );
}
