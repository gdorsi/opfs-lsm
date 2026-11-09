/**
 * Tells a Db when its page stops running and when it runs again. `suspend`
 * is called while the page still runs. Returns a function that stops
 * listening.
 */
export type Lifecycle = (on: { suspend(): void; resume(): void }) => () => void;

/**
 * The page's own events: `freeze` and `pagehide` into the back/forward
 * cache, then `resume` and `pageshow` out of it. Chrome fires both of a
 * pair for the cache, so `suspend` and `resume` may come twice. Undefined
 * where there is no page: Node, and workers.
 */
export function pageLifecycle(): Lifecycle | undefined {
  if (typeof document === "undefined" || typeof window === "undefined") return undefined;
  return (on) => {
    const hide = (ev: PageTransitionEvent) => {
      if (ev.persisted) on.suspend();
    };
    const show = (ev: PageTransitionEvent) => {
      if (ev.persisted) on.resume();
    };
    const freeze = () => on.suspend();
    const resume = () => on.resume();
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    document.addEventListener("freeze", freeze);
    document.addEventListener("resume", resume);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      document.removeEventListener("freeze", freeze);
      document.removeEventListener("resume", resume);
    };
  };
}
