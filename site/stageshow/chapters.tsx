import { useMemo, useRef } from "react";
import { Stage, useReducedMotion, type Act, type StageProps } from "./kit";
import type { Playhead } from "./playhead.ts";

/** `beats[n]` plays chapter n, from `frames[n - 1]` to `frames[n]`. */
export type Beat<S> = (a: Act<S>) => Promise<void>;

/** What the page's player gives a scene told in chapters. */
export type PlayerProps = {
  /** The chapter to play from. A new object restarts the scene there. */
  readonly jump: { readonly chapter: number };
  readonly playhead: Playhead;
  /** Called as each chapter starts, with the playhead's time then. */
  readonly onChapter: (chapter: number, startedAt: number) => void;
};

type Own<S> = Pick<StageProps<S>, "width" | "height" | "compact" | "cursor" | "theme" | "accent" | "tokens" | "className" | "children">;

/** The act a beat gets: its waits read the playhead, so they stand still while the player is paused. */
function paced<S>(a: Act<S>, playhead: Playhead): Act<S> {
  const wait = async (ms: number) => {
    const end = playhead.now() + ms;
    for (let left = ms; left > 0; left = end - playhead.now()) await a.wait(Math.min(left, 100));
  };
  return new Proxy(a, { get: (act, key) => (key === "wait" ? wait : Reflect.get(act, key, act)) });
}

/**
 * A scene told in chapters, played one after another in a loop. `frames[n]` is the whole scene at the end of chapter
 * n, and chapter n runs `ms[n]`: its beat, then the frame held for reading. A jump starts the chapter from the frame
 * before it. Under reduced motion the scene is the still of the chapter jumped to. A pause holds the beat at its next
 * wait. `frames`, `beats` and `ms` must be stable: the stage restarts its script when they change.
 */
export function Chapters<S extends object>({
  jump,
  playhead,
  onChapter,
  frames,
  beats,
  ms,
  children,
  ...stage
}: Own<S> & PlayerProps & { frames: readonly S[]; beats: readonly (Beat<S> | undefined)[]; ms: readonly number[] }) {
  const reduced = useReducedMotion();
  const start = (chapter: number) => frames[Math.max(0, chapter - 1)]!;
  // The chapter on show. The stage restarts the script when it comes back on screen, and the script resumes here.
  const from = useRef(jump.chapter);
  const report = useRef(onChapter);
  report.current = onChapter;

  const script = useMemo(() => {
    from.current = jump.chapter;
    return async (a: Act<S>) => {
      const p = paced(a, playhead);
      let chapter = from.current;
      await a.snap(start(chapter));
      for (;;) {
        const t0 = playhead.now();
        from.current = chapter;
        report.current(chapter, t0);
        await beats[chapter]?.(p);
        await a.set(frames[chapter]!);
        await p.wait(Math.max(0, ms[chapter]! - (playhead.now() - t0)));
        chapter = (chapter + 1) % frames.length;
        // Back to the start, by the same transitions the story came by.
        if (chapter === 0) await a.set(frames[0]!);
      }
    };
  }, [jump, playhead, frames, beats, ms]);

  return (
    <Stage<S>
      // Under reduced motion the stage is a still: each chapter is its own still.
      key={reduced ? `still-${jump.chapter}` : "live"}
      {...stage}
      initial={start(jump.chapter)}
      poster={frames[jump.chapter]}
      script={script}
      play="once"
    >
      {children}
    </Stage>
  );
}
