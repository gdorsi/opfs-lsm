import { useLayoutEffect, useRef, useState } from "react";
import { Avatar, Badge, Bar, Check, Collapse, Icon, Row, Spinner, Stage, States, Text, Window, type Act } from "../kit";
import { ACCENT, tokens, type SceneTheme } from "../look.ts";
import { COMPACT_BELOW, SIZES } from "../sizes.ts";
import "./sync.css";

// The hero: kv under a sync engine, as a system story with no cursor. An app's issue list is synced; its sync
// engine starts syncing, two issues arrive in the list, and each is written to kv under its key and acked. The
// app is synced again, and the SharedWorker flushes the new writes to OPFS. The kv card leads with the size kv
// adds to the main bundle. Plays once; the still is the end.
//
// Both lists show the newest first, so a new row arrives at the top and carries the older ones down. The size
// comes from the page's frontmatter, which the build checks against README.md.

type Props = { readonly theme: SceneTheme; readonly main: string };

/**
 * `syncing`: the sync engine is applying changes. `shown`: issues in the app. `put`: keys written to kv. `acked`:
 * keys acked. `flushing`: the SharedWorker is writing the acked keys to OPFS; before and after, what was acked is
 * there.
 */
type S = { syncing: boolean; shown: number; put: number; acked: number; flushing: boolean };

const START: S = { syncing: false, shown: 0, put: 0, acked: 0, flushing: false };
const END: S = { ...START, shown: 2, put: 2, acked: 2 };

/** The issues the sync brings, in the order they arrive, with their assignee and the key each is written under. */
const ISSUES = [
  { title: "Offline mode", who: "Maya", key: "issue:offline-mode" },
  { title: "Fix login redirect", who: "Leo", key: "issue:login-redirect" },
];
const OLDER = { title: "Dark mode", who: "Ana", key: "issue:dark-mode" };

/**
 * Filler issues under the named ones. Wide, they run off the stage's foot from the first frame. Narrow, they fade
 * out behind the kv card and stop short of the window's foot. Either way, the last ones close as the new issues
 * open, so the list keeps its length.
 */
const FILL = { wide: [96, 72, 110, 84, 64, 90, 76], compact: [96, 72, 110, 84] };

async function script(a: Act<S>) {
  await a.wait(900);
  a.mark("sync");
  a.put({ syncing: true });
  await a.wait(600);
  for (let i = 0; i < ISSUES.length; i++) {
    a.mark(`issue-${i}`);
    a.put({ shown: i + 1 });
    await a.wait(320);
    a.put({ put: i + 1 });
    await a.wait(420);
    a.put({ acked: i + 1 });
    await a.wait(560);
  }
  a.mark("synced");
  a.put({ syncing: false });
  await a.wait(700);
  a.mark("flush");
  a.put({ flushing: true });
  await a.wait(1100);
  a.put({ flushing: false });
  await a.wait(1600);
}

/** One row of the app's list: a named issue with its assignee, or, given only a width, a filler line. */
function Issue({ title, who }: { title: string | number; who?: string }) {
  return (
    <Row
      pad={0}
      className="sy-issue"
      lead={<Check on={false} size={14} className="sy-status" />}
      title={typeof title === "string" ? <Text>{title}</Text> : <Bar w={title} h={7} r={3.5} tone={2} />}
    >
      {who ? <Avatar name={who} size={18} /> : <Bar w={18} h={18} r={9} tone={1} />}
    </Row>
  );
}

/** A key in kv: accent while its write is in flight, plain once acked. */
function Key({ name, acked }: { name: string; acked: boolean }) {
  return (
    <Row pad={0} className="sy-key" title={<Text className="sy-mono" data-new={!acked || undefined}>{name}</Text>}>
      <States
        align="end"
        value={acked ? "acked" : "pending"}
        states={{ pending: <Spinner size={12} className="sy-pending" />, acked: <Badge tone="success">acked</Badge> }}
      />
    </Row>
  );
}

/**
 * A status that changes on its own pill, as two phrases in one cell: the old one fades, the new one fades in, and
 * the cell eases to the width of the one showing, so only the pill's right edge moves and nothing rolls past it.
 */
function Status({ phrases, on, busy }: { phrases: readonly [string, string]; on: 0 | 1; busy: boolean }) {
  const words = useRef<HTMLSpanElement[]>([]);
  const [widths, setWidths] = useState<number[]>([]);
  useLayoutEffect(() => {
    const measure = () => setWidths(words.current.map((e) => e.offsetWidth));
    measure();
    void document.fonts?.ready.then(measure);
  }, []);
  const shrink = widths.length === 2 && widths[on]! < widths[1 - on]!;
  return (
    <Badge
      tone={busy ? "accent" : "neutral"}
      icon={
        <States
          className="sy-badge-icon"
          value={busy ? "busy" : "done"}
          states={{ busy: <Spinner size={12} />, done: <Icon name="check" size={12} stroke={2} /> }}
        />
      }
    >
      <span
        className="sy-phrases"
        data-shrink={shrink || undefined}
        style={widths.length ? { width: widths[on] } : undefined}
      >
        {phrases.map((p, i) => (
          <span
            key={p}
            ref={(e) => {
              if (e) words.current[i] = e;
            }}
            className="sy-phrase"
            data-on={i === on || undefined}
          >
            {p}
          </span>
        ))}
      </span>
    </Badge>
  );
}

export default function Sync({ theme, main }: Props) {
  const { wide, compact } = SIZES.sync;
  return (
    <Stage<S>
      width={wide[0]}
      height={wide[1]}
      compact={{ below: COMPACT_BELOW, width: compact[0], height: compact[1] }}
      initial={START}
      poster={END}
      script={script}
      play="once"
      theme={theme}
      accent={ACCENT}
      tokens={tokens(theme)}
      className="sy"
    >
      {(s, _rect, layout) => {
        const fill = FILL[layout];
        return (
          <>
            <div className="sy-frame">
              <Window url="localhost" className="sy-window">
                <div className="sy-app">
                  <aside className="sy-side">
                    {[58, 44, 66, 50].map((w, i) => (
                      <div key={w} className="sy-nav" data-on={i === 0 || undefined}>
                        <Bar w={12} h={12} r={3} tone={i === 0 ? 4 : 2} />
                        <Bar w={w} h={6} r={3} tone={i === 0 ? 4 : 2} />
                      </div>
                    ))}
                  </aside>
                  <main className="sy-main">
                    <div className="sy-head">
                      <div className="sy-title">Issues</div>
                      <Status phrases={["Syncing", "Synced"]} on={s.syncing ? 0 : 1} busy={s.syncing} />
                    </div>
                    <div className="sy-list">
                      {ISSUES.map((issue, i) => ({ issue, i }))
                        .reverse()
                        .map(({ issue, i }) => (
                          <Collapse key={issue.key} open={s.shown > i}>
                            <Issue title={issue.title} who={issue.who} />
                          </Collapse>
                        ))}
                      <Issue title={OLDER.title} who={OLDER.who} />
                      {fill.map((w, i) => (
                        <Collapse key={w} open={s.shown < fill.length - i}>
                          <Issue title={w} />
                        </Collapse>
                      ))}
                    </div>
                  </main>
                </div>
              </Window>
            </div>

            <section className="sy-kv">
              <header className="sy-kv-head">
                <Text className="sy-kv-name">@opfs-lsm/kv</Text>
                <div className="sy-kv-size">
                  <span className="sy-kv-value">{main}</span>
                  <Text className="sy-kv-unit">in your main bundle</Text>
                </div>
              </header>
              <div className="sy-keys">
                {ISSUES.map((issue, i) => ({ issue, i }))
                  .reverse()
                  .map(({ issue, i }) => (
                    <Collapse key={issue.key} open={s.put > i}>
                      <Key name={issue.key} acked={s.acked > i} />
                    </Collapse>
                  ))}
                <Key name={OLDER.key} acked />
                {/* Filler under the real keys, closing as new keys open above, so the list keeps its three rows. */}
                {[118, 96].map((w, i) => (
                  <Collapse key={w} open={s.put < ISSUES.length - i}>
                    <Row pad={0} className="sy-key" title={<Bar w={w} h={7} r={3.5} tone={2} />}>
                      <Bar w={46} h={20} r={10} tone={1} />
                    </Row>
                  </Collapse>
                ))}
              </div>
              <footer className="sy-worker">
                <Text className="sy-worker-name">SharedWorker</Text>
                <Status
                  phrases={["flushing to OPFS", "flushed to OPFS"]}
                  on={s.flushing ? 0 : 1}
                  busy={s.flushing}
                />
              </footer>
            </section>
          </>
        );
      }}
    </Stage>
  );
}
