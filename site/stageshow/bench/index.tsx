import { useMemo } from "react";
import { Badge, Bar, Count, Meter, Stage, States, type Act } from "../kit";
import { ACCENT, tokens, type SceneTheme } from "../look.ts";
import { COMPACT_BELOW, SIZES } from "../sizes.ts";
import "./bench.css";

// A benchmark run, no cursor. Three workloads run one after the other. In each, the two bars grow for the same
// time, so their lengths are how far each store got: kv's is the full track in the first two, and shorter than
// IndexedDB's in the third, which is the workload kv loses. Plays once; the still is the finished run.
//
// Every figure comes from the page's frontmatter, which the build checks against README.md.

/** `ratio` is the README's own figure. A workload the README gives no ratio for shows the word alone. */
type BenchRow = { readonly workload: string; readonly indexeddb: string; readonly kv: string; readonly ratio?: string };
type Props = { readonly theme: SceneTheme; readonly command: string; readonly rows: readonly BenchRow[] };

/** `ran`: workloads whose bars have started. `done`: workloads whose result shows. */
type S = { ran: number; done: number };

const SCALE: Record<string, number> = { "": 1, k: 1e3, M: 1e6 };

/** "14.3k ops/s" as a number to compare, a number to count up to, and how to write it. */
function figure(text: string) {
  const [, digits = "0", suffix = "", unit = ""] = /^([\d.]+)([kM]?)\s*(.*)$/.exec(text) ?? [];
  const decimals = (digits.split(".")[1] ?? "").length;
  return { shown: Number(digits), amount: Number(digits) * SCALE[suffix]!, unit, write: (n: number) => `${n.toFixed(decimals)}${suffix}` };
}

const FILLER = [118, 92];

export default function Bench({ theme, command, rows }: Props) {
  const script = useMemo(
    () => async (a: Act<S>) => {
      await a.wait(700);
      for (let i = 1; i <= rows.length; i++) {
        a.mark(`run-${i}`);
        a.put({ ran: i });
        await a.wait(1700);
        a.mark(`result-${i}`);
        a.put({ done: i });
        await a.wait(i === rows.length ? 600 : 900);
      }
    },
    [rows.length],
  );
  const { wide, compact } = SIZES.bench;
  return (
    <Stage<S>
      width={wide[0]}
      height={wide[1]}
      compact={{ below: COMPACT_BELOW, width: compact[0], height: compact[1] }}
      initial={{ ran: 0, done: 0 }}
      poster={{ ran: rows.length, done: rows.length }}
      script={script}
      play="once"
      theme={theme}
      accent={ACCENT}
      tokens={tokens(theme)}
      className="bn"
    >
      {(s) => (
        <section className="bn-card">
          <header className="bn-top">
            <div className="bn-title">Benchmarks</div>
            <span className="bn-command">{command}</span>
          </header>
          {rows.map((row, i) => {
            const kv = figure(row.kv);
            const idb = figure(row.indexeddb);
            const most = Math.max(kv.amount, idb.amount);
            const ran = s.ran > i;
            const faster = kv.amount > idb.amount;
            const verdict = faster ? "faster" : "as fast";
            return (
              <div key={row.workload} className="bn-group" data-ran={ran || undefined}>
                <div className="bn-head">
                  <span className="bn-name">{row.workload}</span>
                  <States
                    value={s.done > i ? "done" : ran ? "running" : "queued"}
                    align="end"
                    states={{
                      queued: <Badge>Queued</Badge>,
                      running: <Badge tone="accent">Running</Badge>,
                      done: <Badge tone={faster ? "success" : "warning"}>{row.ratio ? `${row.ratio} ${verdict}` : verdict}</Badge>,
                    }}
                  />
                </div>
                {[
                  { who: "kv", f: kv, tone: "accent" as const },
                  { who: "IndexedDB", f: idb, tone: "ink" as const },
                ].map(({ who, f, tone }) => (
                  <div key={who} className="bn-line">
                    <span className="bn-who">{who}</span>
                    <Meter value={ran ? f.amount / most : 0} tone={tone} />
                    <span className="bn-value">
                      <Count value={ran ? f.shown : 0} format={f.write} duration={900} />
                      <span>{f.unit}</span>
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
          <div className="bn-group">
            <div className="bn-head">
              <Bar w={148} h={7} r={3.5} tone={2} />
              <Bar w={52} h={20} r={10} tone={1} />
            </div>
            {FILLER.map((w) => (
              <div key={w} className="bn-line">
                <Bar w={w === FILLER[0] ? 16 : 56} h={6} r={3} tone={2} />
                <Bar w={w} h={6} r={3} tone={1} />
              </div>
            ))}
          </div>
        </section>
      )}
    </Stage>
  );
}
