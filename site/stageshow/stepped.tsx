import { useEffect, useMemo, useRef } from "react";
import { Stage, useReducedMotion, type Act, type StageProps } from "./kit";
import { Stopped } from "./kit/act";

/** `beats[n]` plays on the way from step n - 1 to step n, before `frames[n]` is applied. */
export type Beat<S> = (a: Act<S>) => Promise<void>;

type Own<S> = Pick<StageProps<S>, "width" | "height" | "compact" | "cursor" | "theme" | "accent" | "tokens" | "className" | "children">;

/**
 * A scene that moves one step each time the page's Next is pressed. `frames[n]` is the whole scene at step n.
 * Going forward by one step plays that step's beat, then lands on its frame. Any other change (Back, Start over,
 * a reload, a jump of two steps) lands on the frame at once. Under reduced motion each step is its own still.
 * `frames` and `beats` must be stable: the stage restarts its script when they change.
 */
export function Stepped<S extends object>({ step, frames, beats, children, ...stage }: Own<S> & { step: number; frames: readonly S[]; beats?: readonly (Beat<S> | undefined)[] }) {
  const at = Math.min(step, frames.length - 1);
  const live = useRef({ step: at, subs: new Set<() => void>() });
  useEffect(() => {
    live.current.step = at;
    live.current.subs.forEach((notify) => notify());
  }, [at]);

  const reduced = useReducedMotion();

  const script = useMemo(
    () => async (a: Act<S>) => {
      // Resolves with the step the page asks for, as soon as it is not `from`.
      const moved = (from: number) =>
        new Promise<number>((resolve, reject) => {
          const { subs } = live.current;
          const off = () => {
            subs.delete(check);
            a.signal.removeEventListener("abort", stop);
          };
          const check = () => {
            if (live.current.step === from) return;
            off();
            resolve(live.current.step);
          };
          const stop = () => {
            off();
            reject(new Stopped());
          };
          subs.add(check);
          a.signal.addEventListener("abort", stop, { once: true });
          check();
        });

      let cur = live.current.step;
      await a.snap(frames[cur]!);
      for (;;) {
        const next = await moved(cur);
        if (next === cur + 1) {
          await beats?.[next]?.(a);
          await a.set(frames[next]!);
        } else {
          await a.snap(frames[next]!);
        }
        cur = next;
      }
    },
    [frames, beats],
  );

  return (
    <Stage<S>
      // Under reduced motion the stage is a still: each step is its own still.
      key={reduced ? `still-${at}` : "live"}
      {...stage}
      initial={frames[at]}
      poster={frames[at]}
      script={script}
      play="once"
    >
      {children}
    </Stage>
  );
}
