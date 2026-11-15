import { useMemo } from "react";
import { Badge, Bar, Count, Meter, Stage, States, type Act } from "../kit";
import { ACCENT, tokens, type SceneTheme } from "../look.ts";
import { FULL_COMPACT_BELOW, SIZES } from "../sizes.ts";
import { ratioTone } from "./tone.ts";
import "./adapters.css";

// A benchmark card as one run, no cursor. Each column is a framework or an app: opfs-lsm against the storage it
// would otherwise use. The columns run one after the other. A rate's bars grow for the same time, so their lengths
// are how far each store got. A time's bars are how long each store took, so there the faster store's bar is the
// shorter. The badge says which one won. Plays once; the still is the finished run.
//
// Every figure comes from the page's frontmatter, which the build checks against README.md.

type Row = { readonly workload: string; readonly indexeddb: string; readonly kv: string; readonly ratio: string };
/** `versus`: the baseline's name on its bar, IndexedDB unless the framework is compared with another store. */
type Framework = { readonly name: string; readonly baseline: string; readonly versus?: string; readonly rows: readonly Row[] };
type Props = { readonly theme: SceneTheme; readonly command: string; readonly frameworks: readonly Framework[] };
type Size = { readonly wide: readonly [number, number]; readonly compact: readonly [number, number] };

/** `ran`: frameworks whose bars have started. `done`: frameworks whose results show. */
type S = { ran: number; done: number };

const SCALE: Record<string, number> = { "": 1, k: 1e3, M: 1e6 };
/** Times in one row may differ in unit, "242 ms" against "3.1 s", so a bar compares them in milliseconds. */
const MS: Record<string, number> = { "µs": 1e-3, ms: 1, s: 1e3 };

/** "9.3k notes/s" as a number to compare, a number to count up to, and how to write it. */
function figure(text: string) {
  const [, digits = "0", suffix = "", unit = ""] = /^([\d.]+)([kM]?)\s*(.*)$/.exec(text) ?? [];
  const decimals = (digits.split(".")[1] ?? "").length;
  const amount = Number(digits) * SCALE[suffix]! * (MS[unit] ?? 1);
  return { shown: Number(digits), amount, unit, write: (n: number) => `${n.toFixed(decimals)}${suffix}` };
}

/** The README's ratio in words. When the two are level, the badge says that, not a number. */
function verdict(ratio: string) {
  const tone = ratioTone(ratio);
  const text = { success: `${ratio} faster`, warning: `${ratio} as fast`, neutral: "about equal" }[tone];
  return { tone, text };
}

/** The app benchmarks: an example app on opfs-lsm against the same app on the storage it would otherwise use. */
export function Apps(props: Props) {
  return <Card {...props} title="App benchmarks" hint="time per step, shorter is better" size={SIZES.apps} />;
}

type CardProps = Props & { readonly title: string; readonly hint?: string; readonly size: Size };

function Card({ theme, title, hint, size, command, frameworks }: CardProps) {
  const script = useMemo(
    () => async (a: Act<S>) => {
      await a.wait(700);
      for (let i = 1; i <= frameworks.length; i++) {
        a.mark(`run-${i}`);
        a.put({ ran: i });
        await a.wait(1500);
        a.mark(`result-${i}`);
        a.put({ done: i });
        await a.wait(i === frameworks.length ? 600 : 700);
      }
    },
    [frameworks.length],
  );
  const { wide, compact } = size;
  return (
    <Stage<S>
      width={wide[0]}
      height={wide[1]}
      compact={{ below: FULL_COMPACT_BELOW, width: compact[0], height: compact[1] }}
      initial={{ ran: 0, done: 0 }}
      poster={{ ran: frameworks.length, done: frameworks.length }}
      script={script}
      play="once"
      theme={theme}
      accent={ACCENT}
      tokens={tokens(theme)}
      className="ad"
    >
      {(s) => (
        <section className="ad-card">
          <header className="ad-top">
            <div className="ad-title">
              {title}
              {hint && <span className="ad-hint">{hint}</span>}
            </div>
            <span className="ad-command">{command}</span>
          </header>
          <div className="ad-cols" data-three={frameworks.length === 3 || undefined}>
            {frameworks.map((framework, i) => {
              const ran = s.ran > i;
              return (
                <div key={framework.name} className="ad-col" data-ran={ran || undefined}>
                  <div className="ad-head">
                    <span className="ad-framework">{framework.name}</span>
                    <span className="ad-versus">vs {framework.baseline}</span>
                  </div>
                  {framework.rows.map((row) => {
                    const kv = figure(row.kv);
                    const idb = figure(row.indexeddb);
                    const most = Math.max(kv.amount, idb.amount);
                    const result = verdict(row.ratio);
                    return (
                      <div key={row.workload} className="ad-group">
                        <div className="ad-work">
                          <span className="ad-name">{row.workload}</span>
                          <States
                            value={s.done > i ? "done" : ran ? "running" : "queued"}
                            align="end"
                            states={{
                              queued: <Badge>Queued</Badge>,
                              running: <Badge tone="accent">Running</Badge>,
                              done: <Badge tone={result.tone}>{result.text}</Badge>,
                            }}
                          />
                        </div>
                        {[
                          { who: "opfs-lsm", f: kv, tone: "accent" as const },
                          { who: framework.versus ?? "IndexedDB", f: idb, tone: "ink" as const },
                        ].map(({ who, f, tone }) => (
                          <div key={who} className="ad-line">
                            <span className="ad-who">{who}</span>
                            <Meter value={ran ? f.amount / most : 0} tone={tone} />
                            <span className="ad-value">
                              <Count value={ran ? f.shown : 0} format={f.write} duration={900} />
                              <span>{f.unit}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                  <div className="ad-group ad-filler">
                    <div className="ad-work">
                      <Bar w={96} h={7} r={3.5} tone={2} />
                      <Bar w={52} h={20} r={10} tone={1} />
                    </div>
                    <div className="ad-line">
                      <Bar w={44} h={6} r={3} tone={2} />
                      <Bar w={84} h={6} r={3} tone={1} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </Stage>
  );
}
