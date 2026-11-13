import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Avatar, Badge, Bar, Check, Count, Icon, Meter, Row, Spinner, Stage, States, Text, Window, type Act } from "../kit";
import { ACCENT, tokens, type SceneTheme } from "../look.ts";
import { COMPACT_BELOW, SIZES } from "../sizes.ts";
import "./reopen.css";

// The hero: an app reopens and loads its data back from disk, as a system story with no cursor. The issue list is a
// skeleton while the load runs. The card beside it runs the same read through opfs-lsm and through the baseline
// store. As in the adapter benchmarks, the two bars grow for the same time, so their lengths are how far each store
// got: when opfs-lsm is done and the list fills from it, the baseline's bar stops short. Then the card says how much
// faster opfs-lsm was. Plays once; the still is the end, where the lengths still show the difference.
//
// Every figure comes from `read` in the page's frontmatter, which the build checks against README.md.

type Props = {
  readonly theme: SceneTheme;
  readonly framework: string;
  readonly workload: string;
  readonly baseline: string;
  readonly other: string;
  readonly kv: string;
  readonly ratio: string;
};

/** `race`: both loads have started. `kv`: opfs-lsm has every row, so the app shows its issues. `verdict`: the badge. */
type S = { race: boolean; kv: boolean; verdict: boolean };

const START: S = { race: false, kv: false, verdict: false };
const END: S = { race: true, kv: true, verdict: true };

/** How long both bars grow. opfs-lsm's fills; the baseline's reaches the ratio of the two rates. */
const RACE_MS = 1800;

const SCALE: Record<string, number> = { "": 1, k: 1e3, M: 1e6 };

/** "176k rows/s" as a number to compare, a number to count up to, and how to write it. */
function figure(text: string) {
  const [, digits = "0", suffix = "", unit = ""] = /^([\d.]+)([kM]?)\s*(.*)$/.exec(text) ?? [];
  const decimals = (digits.split(".")[1] ?? "").length;
  return { shown: Number(digits), amount: Number(digits) * SCALE[suffix]!, unit, write: (n: number) => `${n.toFixed(decimals)}${suffix}` };
}

/** The README's ratio in words. Within a twentieth of 1 the two are level, and the badge says that, not a number. */
function verdict(ratio: string) {
  const times = Number.parseFloat(ratio);
  if (times >= 1.05) return { tone: "success" as const, text: `${ratio} faster` };
  if (times <= 0.95) return { tone: "warning" as const, text: `${ratio} as fast` };
  return { tone: "neutral" as const, text: "about equal" };
}

/**
 * The list, top to bottom: named issues with their assignees, then filler. `sk` is the skeleton bar's width for the
 * title, about the words' width, so nothing moves when the words arrive.
 */
const ISSUES: readonly { title: string | number; who?: string; sk: number }[] = [
  { title: "Offline mode", who: "Maya", sk: 78 },
  { title: "Fix login redirect", who: "Leo", sk: 108 },
  { title: "Dark mode", who: "Ana", sk: 64 },
  { title: 96, sk: 96 },
  { title: 72, sk: 72 },
  { title: 110, sk: 110 },
  { title: 84, sk: 84 },
  { title: 64, sk: 64 },
];

/** A skeleton bar and what replaces it, in one cell: the bar fades as the content fades in, in place. */
function Slot({ sk, children }: { sk: { w: number; h: number }; children: ReactNode }) {
  return (
    <span className="ro-slot">
      <Bar w={sk.w} h={sk.h} r={sk.h / 2} tone={1} className="ro-sk" />
      <span className="ro-real">{children}</span>
    </span>
  );
}

/** One row of the app's list: a named issue with its assignee, or, given only a width, a filler line. */
function Issue({ title, who, sk }: { title: string | number; who?: string; sk: number }) {
  return (
    <Row
      pad={0}
      className="ro-issue"
      lead={
        <Slot sk={{ w: 14, h: 14 }}>
          <Check on={false} size={14} className="ro-status" />
        </Slot>
      }
      title={
        <Slot sk={{ w: sk, h: 8 }}>
          {typeof title === "string" ? <Text>{title}</Text> : <Bar w={title} h={7} r={3.5} tone={2} />}
        </Slot>
      }
    >
      <Slot sk={{ w: 18, h: 18 }}>{who ? <Avatar name={who} size={18} /> : <Bar w={18} h={18} r={9} tone={1} />}</Slot>
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
          className="ro-badge-icon"
          value={busy ? "busy" : "done"}
          states={{ busy: <Spinner size={12} />, done: <Icon name="check" size={12} stroke={2} /> }}
        />
      }
    >
      <span
        className="ro-phrases"
        data-shrink={shrink || undefined}
        style={widths.length ? { width: widths[on] } : undefined}
      >
        {phrases.map((p, i) => (
          <span
            key={p}
            ref={(e) => {
              if (e) words.current[i] = e;
            }}
            className="ro-phrase"
            data-on={i === on || undefined}
          >
            {p}
          </span>
        ))}
      </span>
    </Badge>
  );
}

export default function Reopen({ theme, framework, workload, baseline, other, kv, ratio }: Props) {
  const ours = figure(kv);
  const theirs = figure(other);
  const result = verdict(ratio);
  const script = useMemo(
    () => async (a: Act<S>) => {
      await a.wait(1000);
      a.mark("race");
      a.put({ race: true });
      await a.wait(RACE_MS);
      a.mark("loaded");
      a.put({ kv: true });
      await a.wait(900);
      a.mark("verdict");
      a.put({ verdict: true });
      await a.wait(1800);
    },
    [],
  );
  const { wide, compact } = SIZES.reopen;
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
      className="ro"
    >
      {(s) => (
        <>
          <div className="ro-frame">
            <Window url="localhost" className="ro-window">
              <div className="ro-app">
                <aside className="ro-side">
                  {[58, 44, 66, 50].map((w, i) => (
                    <div key={w} className="ro-nav" data-on={i === 0 || undefined}>
                      <Bar w={12} h={12} r={3} tone={i === 0 ? 4 : 2} />
                      <Bar w={w} h={6} r={3} tone={i === 0 ? 4 : 2} />
                    </div>
                  ))}
                </aside>
                <main className="ro-main">
                  <div className="ro-head">
                    <div className="ro-title">Issues</div>
                    <Status phrases={["Loading from disk", "Loaded from disk"]} on={s.kv ? 1 : 0} busy={!s.kv} />
                  </div>
                  <div className="ro-list" data-loaded={s.kv || undefined}>
                    {ISSUES.map((issue, i) => (
                      <div key={i} className="ro-item" style={{ ["--i" as string]: i }}>
                        <Issue {...issue} />
                      </div>
                    ))}
                  </div>
                </main>
              </div>
            </Window>
          </div>

          <section className="ro-card">
            <header className="ro-card-head">
              <div className="ro-work">
                <span className="ro-work-name">{framework}</span>
                <span className="ro-work-size">{workload}</span>
              </div>
              <States
                value={s.verdict ? "done" : "running"}
                align="end"
                states={{
                  running: <Badge tone="accent">Running</Badge>,
                  done: <Badge tone={result.tone}>{result.text}</Badge>,
                }}
              />
            </header>
            {[
              { who: "opfs-lsm", f: ours, reach: 1, tone: "accent" as const },
              { who: baseline, f: theirs, reach: theirs.amount / ours.amount, tone: "ink" as const },
            ].map(({ who, f, reach, tone }) => (
              <div key={who} className="ro-line" data-done={s.kv || undefined}>
                <div className="ro-label">
                  <span className="ro-who">{who}</span>
                  <span className="ro-value">
                    <Count value={s.kv ? f.shown : 0} format={f.write} duration={700} />
                    <span>{f.unit}</span>
                  </span>
                </div>
                <Meter value={s.race ? Math.min(1, reach) : 0} tone={tone} style={{ ["--ro-ms" as string]: `${RACE_MS}ms` }} />
              </div>
            ))}
          </section>
        </>
      )}
    </Stage>
  );
}
