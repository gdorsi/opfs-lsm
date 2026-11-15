/**
 * The canvas and its DOM boundary. Converts PointerEvent, WheelEvent, KeyboardEvent and Safari's GestureEvent into
 * the controller's InputEvents, and runs the frame loop: one requestAnimationFrame applies the coalesced input
 * (controller.frame) and paints what changed (renderer.paint). Nothing else in the app touches these events.
 */
import { useEffect, useRef, type ReactNode } from "react";
import type { Board } from "../model/index.ts";
import { toScreen, wheelPixels } from "./core/camera.ts";
import type { Controller, InputEvent, PointerSample, TextEditing } from "./core/input.ts";
import type { KeySample } from "./core/keys.ts";
import { FONT, LINE_HEIGHT } from "./core/text.ts";
import { useBoardSlice, useUi } from "./hooks.ts";
import { createRenderer } from "./paint.ts";

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function Stage({ board, controller }: { board: Board; controller: Controller }) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<HTMLCanvasElement>(null);
  const top = useRef<HTMLCanvasElement>(null);
  const ui = useUi(controller);

  useEffect(() => {
    const hostEl = host.current!;
    const topEl = top.current!;
    const renderer = createRenderer(scene.current!, topEl);
    let origin = hostEl.getBoundingClientRect();
    let stageHeight = origin.height;
    const loop = frameLoop(() => {
      controller.frame();
      renderer.paint(board.view(), controller.overlay());
      topEl.style.cursor = controller.cursor();
    });
    const send = (e: InputEvent): boolean => {
      const used = controller.send(e);
      loop.request();
      return used;
    };
    const sampleOf = (e: PointerEvent) => sample(e, origin);

    const resize = () => {
      origin = hostEl.getBoundingClientRect();
      stageHeight = origin.height;
      renderer.resize({ w: origin.width, h: origin.height, dpr: window.devicePixelRatio || 1 });
      send({ type: "stage", size: { w: origin.width, h: origin.height } });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(hostEl);
    resize();

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      origin = hostEl.getBoundingClientRect();
      topEl.setPointerCapture(e.pointerId);
      if (send({ type: "down", p: sampleOf(e) })) e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      const samples = e.buttons !== 0 ? (e.getCoalescedEvents?.() ?? []) : [];
      for (const c of samples.length > 0 ? samples : [e]) controller.send({ type: "move", p: sample(c, origin) });
      loop.request();
    };
    const onUp = (e: PointerEvent) => void send({ type: "up", p: sampleOf(e) });
    const onCancel = (e: PointerEvent) => void send({ type: "cancel", pointerId: e.pointerId });
    const onDouble = (e: MouseEvent) => void send({ type: "dblclick", p: sample(e, origin) });
    const onWheel = (e: WheelEvent) => {
      let dx = wheelPixels(e.deltaX, e.deltaMode, stageHeight);
      let dy = wheelPixels(e.deltaY, e.deltaMode, stageHeight);
      if (e.shiftKey && dx === 0 && !MAC) [dx, dy] = [dy, 0];
      const zoom = e.ctrlKey || e.metaKey;
      if (send({ type: "wheel", screen: { x: e.clientX - origin.left, y: e.clientY - origin.top }, dx, dy, zoom })) e.preventDefault();
    };
    let lastScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      lastScale = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      send({ type: "pinch", screen: { x: g.clientX - origin.left, y: g.clientY - origin.top }, factor: g.scale / lastScale });
      lastScale = g.scale;
    };
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      if (e.isComposing || editable(e.target)) return;
      if (send({ type: "key", down, key: keySample(e), t: e.timeStamp })) e.preventDefault();
    };
    const onKeyDown = onKey(true);
    const onKeyUp = onKey(false);
    const onBlur = () => void send({ type: "blur" });
    const onHidden = () => {
      if (document.visibilityState === "hidden") onBlur();
    };
    const stop = (e: Event) => e.preventDefault();

    topEl.addEventListener("pointerdown", onDown);
    topEl.addEventListener("pointermove", onMove);
    topEl.addEventListener("pointerup", onUp);
    topEl.addEventListener("pointercancel", onCancel);
    topEl.addEventListener("lostpointercapture", onCancel);
    topEl.addEventListener("dblclick", onDouble);
    topEl.addEventListener("contextmenu", stop);
    topEl.addEventListener("wheel", onWheel, { passive: false });
    topEl.addEventListener("gesturestart", onGestureStart);
    topEl.addEventListener("gesturechange", onGestureChange);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHidden);
    const off = [board.subscribe(loop.request), controller.subscribe(loop.request)];
    loop.request();

    // The cleanup only abandons a live phase: the controller stays usable, so StrictMode's remount is safe.
    return () => {
      topEl.removeEventListener("pointerdown", onDown);
      topEl.removeEventListener("pointermove", onMove);
      topEl.removeEventListener("pointerup", onUp);
      topEl.removeEventListener("pointercancel", onCancel);
      topEl.removeEventListener("lostpointercapture", onCancel);
      topEl.removeEventListener("dblclick", onDouble);
      topEl.removeEventListener("contextmenu", stop);
      topEl.removeEventListener("wheel", onWheel);
      topEl.removeEventListener("gesturestart", onGestureStart);
      topEl.removeEventListener("gesturechange", onGestureChange);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onHidden);
      observer.disconnect();
      for (const f of off) f();
      loop.stop();
      controller.send({ type: "blur" });
    };
  }, [board, controller]);

  return (
    <div ref={host} className="stage">
      <canvas ref={scene} className="stage-scene" />
      <canvas ref={top} className="stage-top" />
      {ui.editing && <TextEditor board={board} controller={controller} editing={ui.editing} />}
    </div>
  );
}

/**
 * The open text editor: a textarea laid over the text's frame, in screen px from the viewport. The draft lives in
 * the controller (text-input on every input), so a pointer down on the canvas can commit it before the textarea
 * blurs. Escape and mod+Enter commit; Enter is a new line. A blur commits only while the window has focus, so
 * switching apps keeps the editor open.
 */
function TextEditor({ board, controller, editing }: { board: Board; controller: Controller; editing: TextEditing }): ReactNode {
  const viewport = useBoardSlice(board, (v) => v.viewport);
  const at = toScreen(viewport, editing.at);
  const fontPx = editing.fontSize * editing.scale * viewport.zoom;
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <textarea
      ref={ref}
      className="text-editor"
      value={editing.draft}
      wrap="off"
      spellCheck={false}
      style={{
        left: at.x,
        top: at.y,
        width: (editing.size.w + editing.fontSize * editing.scale) * viewport.zoom,
        height: editing.size.h * viewport.zoom,
        font: `${fontPx}px ${FONT}`,
        lineHeight: LINE_HEIGHT,
        color: editing.color,
      }}
      onChange={(e) => controller.send({ type: "text-input", draft: e.target.value })}
      onKeyDown={(e) => {
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          controller.send({ type: "text-commit" });
        }
      }}
      onBlur={() => document.hasFocus() && controller.send({ type: "text-commit" })}
    />
  );
}

/**
 * One requestAnimationFrame at a time. Requests made while the frame runs (the model publishing during
 * controller.frame) are absorbed: the paint that follows in the same frame reads the latest view.
 */
function frameLoop(run: () => void): { request(): void; stop(): void } {
  let id = 0;
  let running = false;
  const tick = () => {
    id = 0;
    running = true;
    try {
      run();
    } finally {
      running = false;
    }
  };
  return {
    request() {
      if (!id && !running) id = requestAnimationFrame(tick);
    },
    stop() {
      cancelAnimationFrame(id);
      id = 0;
    },
  };
}

/** The boundary: a PointerEvent (or a dblclick's MouseEvent) as the controller reads it. Stage-relative px from the cached host rect. */
function sample(e: PointerEvent | MouseEvent, origin: { left: number; top: number }): PointerSample {
  const type = (e as PointerEvent).pointerType;
  return {
    pointerId: (e as PointerEvent).pointerId ?? 1,
    kind: type === "touch" ? "touch" : type === "pen" ? "pen" : "mouse",
    button: e.button,
    screen: { x: e.clientX - origin.left, y: e.clientY - origin.top },
    shift: e.shiftKey,
    alt: e.altKey,
    mod: MAC ? e.metaKey : e.ctrlKey,
    t: e.timeStamp,
  };
}

function keySample(e: KeyboardEvent): KeySample {
  return { key: e.key, mod: MAC ? e.metaKey : e.ctrlKey, shift: e.shiftKey, alt: e.altKey, repeat: e.repeat };
}

/** Keys typed into a field belong to the field. */
function editable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}
