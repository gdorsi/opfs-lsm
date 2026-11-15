import type { ComponentType } from "react";
import { Avatar, Badge, Bar, Card, Check, Chip, Code, Connector, Icon, Meter, Row, Spinner, Stage, States, Text, type Act, type Layout, type Rect } from "../kit";
import { ACCENT, tokens, type SceneTheme } from "../look.ts";
import { COMPACT_BELOW, SIZES } from "../sizes.ts";
import "./features.css";

// The home page's hero: opfs-lsm's six features as one ruled grid on the page's soft gray, with no cursor. Each tile
// does one small thing, once, in reading order. Live subscriptions leads: an issue checked off in tab 1 shows as
// checked in tab 2, then one checked off in tab 2 shows in tab 1. Plays once; the still is the end, with every
// result on screen.
//
// One Stage holds the whole grid, not one per tile: the hero's column shows it at 1:1, so no title is drawn under
// its design size.

type Props = { readonly theme: SceneTheme };

/** `n`: how many of the tile's own beats have played. */
type PictureProps = { readonly n: number; readonly layout: Layout; readonly rect: (name: string) => Rect };

/** What a tile shows. The lead spans two columns and two rows; on a phone the diagram runs across the foot. */
type Kind = "lead" | "statement" | "component" | "collection" | "diagram";

type Feature = {
  readonly key: string;
  readonly title: string;
  readonly kind: Kind;
  /** When each of the picture's beats plays, in ms after its tile starts. */
  readonly beats: readonly number[];
  readonly Picture: ComponentType<PictureProps>;
};

/** In reading order, which is the order the grid places them and the order they play. */
const FEATURES: readonly Feature[] = [
  { key: "live", title: "Live subscriptions", kind: "lead", beats: [0, 800, 1900, 2700], Picture: Live },
  { key: "light", title: "Lightweight & fast", kind: "statement", beats: [0], Picture: Bolt },
  { key: "quota", title: "Quota management", kind: "component", beats: [300, 1500], Picture: Quota },
  { key: "adapters", title: "Use it with your framework", kind: "collection", beats: [0], Picture: Adapters },
  { key: "api", title: "A low-level API for your own adapter", kind: "component", beats: [0], Picture: Api },
  { key: "crash", title: "Fault tolerant and consistent", kind: "diagram", beats: [300, 1400], Picture: Crash },
];

const LEAD = 300;
const STEP = 100;

/** Every tile's beats in the order they play. The scene's one state is how many have played. */
const TIMELINE = FEATURES.flatMap(({ key, beats }, i) =>
  beats.map((after, beat) => ({ key, beat: beat + 1, at: LEAD + i * STEP + after })),
).sort((a, b) => a.at - b.at);

type S = { played: number };

async function script(a: Act<S>) {
  let now = 0;
  for (const [i, { key, beat, at }] of TIMELINE.entries()) {
    await a.wait(at - now);
    now = at;
    a.mark(`${key}-${beat}`);
    a.put({ played: i + 1 });
  }
  await a.wait(1200);
}

/* Live subscriptions: two tabs of one app over one database. */

const TABS = ["Tab 1", "Tab 2"] as const;

/** The list both tabs show. The named issues are the two writes, in order: each is checked off in the tab `from`. */
const ISSUES: readonly ({ title: string; who: string; from: 0 | 1 } | { bar: number })[] = [
  { title: "Offline mode", who: "Maya", from: 0 },
  { title: "Dark mode", who: "Leo", from: 1 },
  { bar: 96 },
  { bar: 72 },
  { bar: 84 },
];

function Live({ n, layout, rect }: PictureProps) {
  const wide = layout === "wide";
  // Write i lands in its own tab at beat 2i + 1 and reaches the other tab one beat later.
  const done = (tab: number, i: number) => {
    const issue = ISSUES[i]!;
    return "from" in issue && n >= 2 * i + (issue.from === tab ? 1 : 2);
  };
  const box = rect("live");
  const tabs = [rect("live-tab-0"), rect("live-tab-1")] as const;
  return (
    <div className="ft-live" data-target="live">
      {TABS.map((name, tab) => (
        <Card key={name} pad="small" flush className="ft-tab" data-target={`live-tab-${tab}`}>
          <div className="ft-tab-head">
            <Text>{name}</Text>
          </div>
          <div className="ft-tab-list">
            {ISSUES.map((issue, i) =>
              "title" in issue ? (
                <Row key={i} pad={8} data-target={`live-${tab}-${i}`} lead={<Check on={done(tab, i)} size={14} />} title={<Text>{issue.title}</Text>}>
                  {wide && <Avatar name={issue.who} size={18} />}
                </Row>
              ) : (
                <Row key={i} pad={8} lead={<Check on={false} size={14} />} title={<Bar w={issue.bar} h={7} r={3.5} tone={2} />}>
                  {wide && <Bar w={18} h={18} r={9} tone={1} />}
                </Row>
              ),
            )}
          </div>
        </Card>
      ))}
      {box.width > 0 &&
        ISSUES.map((issue, i) => {
          if (!("from" in issue)) return null;
          const row = rect(`live-${issue.from}-${i}`);
          const y = row.y + row.height / 2 - box.y;
          const left = tabs[0].x + tabs[0].width - box.x + 5;
          const right = tabs[1].x - box.x - 5;
          const [from, to] = issue.from === 0 ? [left, right] : [right, left];
          return <Connector key={i} show={n >= 2 * i + 1} route="straight" arrow from={{ x: from, y }} to={{ x: to, y }} />;
        })}
    </div>
  );
}

/* Lightweight & fast: the title is the statement, so the picture is its one glyph. */

function Bolt({ n }: PictureProps) {
  return (
    <span className="ft-bolt" data-on={n > 0 || undefined}>
      <Icon name="bolt" filled size={22} />
    </span>
  );
}

/* Quota management: storage fills to the app's cap, the app evicts its oldest data, and usage falls back under it. */

const USAGE = [0.62, 1, 0.8] as const;

function Quota({ n }: PictureProps) {
  return (
    <div className="ft-quota">
      <Text className="ft-quota-label">Storage</Text>
      <States
        className="ft-quota-status"
        value={["under", "cap", "evicted"][n]!}
        align="end"
        states={{
          under: <span />,
          cap: <Badge tone="warning">At your cap</Badge>,
          evicted: <Badge tone="accent">Oldest evicted</Badge>,
        }}
      />
      <Meter value={USAGE[n]!} className="ft-meter" />
    </div>
  );
}

/* Use it with your framework: the adapters, by name. */

const ADAPTERS = [
  ["TanStack DB", "Yjs"],
  ["Automerge", "fate"],
] as const;

function Adapters({ n }: PictureProps) {
  return (
    <div className="ft-adapters">
      {ADAPTERS.map((line, i) => (
        <div key={i} className="ft-adapter-line">
          {line.map((name, j) => (
            <Chip key={name} show={n > 0} gap={8} className="ft-chip" style={{ ["--i" as string]: i * 2 + j }}>
              {name}
            </Chip>
          ))}
        </div>
      ))}
    </div>
  );
}

/* A low-level API for your own adapter: a batch of puts and deletes on keys and bytes, written in. */

const BATCH = ["db.batch((tx) => {", "  tx.put(key, bytes);", "  tx.delete(old);", "});"];

function Api({ n }: PictureProps) {
  return (
    <Card pad="small" className="ft-code">
      <Code lines={BATCH} numbers={false} count={n > 0 ? BATCH.length : 1} />
    </Card>
  );
}

/* Fault tolerant and consistent: a tab crashes in the middle of a write, and the database reopens with every
   acked write. The write in flight was never acked, so it is not there. */

const ACKED = 4;

function Records({ inFlight }: { inFlight: boolean }) {
  return (
    <span className="ft-records">
      {Array.from({ length: ACKED }, (_, i) => (
        <span key={i} className="ft-record" />
      ))}
      <span className="ft-record" data-in-flight={inFlight || undefined} />
    </span>
  );
}

function Crash({ n }: PictureProps) {
  return (
    <div className="ft-crash">
      <div className="ft-lane">
        <States
          value={n > 0 ? "crashed" : "writing"}
          align="start"
          states={{
            writing: (
              <span className="ft-lane-label">
                <Spinner size={14} />
                Writing
              </span>
            ),
            crashed: (
              <span className="ft-lane-label" data-tone="danger">
                <Icon name="close" size={14} stroke={2} />
                Crashed
              </span>
            ),
          }}
        />
        <Records inFlight />
      </div>
      <div className="ft-lane" data-on={n > 1 || undefined}>
        <span className="ft-lane-label" data-tone="success">
          <Icon name="check" size={14} stroke={2} />
          Reopened
        </span>
        <Records inFlight={false} />
      </div>
    </div>
  );
}

export default function Features({ theme }: Props) {
  const { wide, compact } = SIZES.features;
  return (
    <Stage<S>
      width={wide[0]}
      height={wide[1]}
      compact={{ below: COMPACT_BELOW, width: compact[0], height: compact[1] }}
      initial={{ played: 0 }}
      poster={{ played: TIMELINE.length }}
      script={script}
      play="once"
      theme={theme}
      accent={ACCENT}
      tokens={tokens(theme)}
      className="ft"
    >
      {(s, rect, layout) => (
        <div className="ft-grid">
          {FEATURES.map(({ key, title, kind, Picture }) => (
            <section key={key} className="ft-tile" data-kind={kind} data-crop>
              <div className="ft-picture" data-crop>
                <Picture n={TIMELINE.slice(0, s.played).filter((b) => b.key === key).length} layout={layout} rect={rect} />
              </div>
              <div className="ft-title">{title}</div>
            </section>
          ))}
        </div>
      )}
    </Stage>
  );
}
