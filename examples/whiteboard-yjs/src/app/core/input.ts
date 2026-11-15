/**
 * The interaction controller: every pointer, wheel and key event of the canvas, and every toolbar action, goes through
 * `send`. It is the only module that calls Board.dispatch, beginGesture, select, setViewport, undo and redo.
 * Pure TypeScript over the model: no DOM, no React, no clock. Node tests drive it against a real Board on
 * memoryStorage.
 *
 * State is one value, `Mode`. A pointer interaction is one `Phase`. A live model Gesture exists only inside the
 * translate, resize, draw and nudge phases, so code that runs while idle cannot reach a stale handle, and a gesture
 * ends exactly when its phase does.
 *
 * Transitions (tool "select" unless named; `b` is the pointer in board space):
 *
 *   phase     event                         guard                           effect                                   next
 *   idle      down                          middle button, or space held    -                                        pan
 *   idle      down                          on a handle of the selection    -                                        press(handle)
 *   idle      down                          on a shape (hitTop)             select it (shift: add) unless selected   press(shape)
 *   idle      down                          in a multi-selection's box      -                                        press(selection)
 *   idle      down                          on nothing                      -                                        press(empty)
 *   idle      down                          tool rect/ellipse/diamond/arrow -                                        sizing
 *   idle      down                          tool text                       -                                        press(text-point)
 *   idle      down                          tool pen                        beginGesture(draw); update(b)            draw
 *   press     move past 4 px (8 for touch)  target shape or selection       beginGesture(translate, selection)       translate
 *   press     move past threshold           target handle                   beginGesture(resize, from: handle box)   resize
 *   press     move past threshold           target empty                    -                                        marquee
 *   press     up                            -                               click rules (see click)                  idle
 *   translate|resize  frame                 a sample is due                 gesture.update(absolute target, e.t)     same
 *   draw      move                          >= 2 px from the last point     queue the point                          same
 *   draw      frame                         points queued                   gesture.update(point, e.t) for each      same
 *   marquee   frame                         -                               overlay.marquee = rect                   same
 *   sizing    frame                         -                               overlay.preview = dragFrame(...)         same
 *   pan|pinch frame                         -                               setViewport(...)                         same
 *   any live  up (its pointer)              -                               frame() first, then end / select / create idle
 *   any live  cancel | blur | Escape        -                               gesture.cancel() / drop the preview      idle
 *   any       second touch down             both pointers are touches       cancel the phase                         pinch
 *   any       wheel                         -                               setViewport; a live phase re-aims        same
 *   idle      arrow key, selection          -                               beginGesture(translate); update          nudge
 *   nudge     arrow key (auto-repeat)       -                               update with the offset so far            same
 *   nudge     keyup of the last arrow       -                               end()                                    idle
 *   idle      key or toolbar action         -                               perform(action)                          idle
 *   not idle  key or toolbar action         not a zoom                      refused: send returns false              same
 *
 * The model throws when dispatch, undo, redo or beginGesture runs during a gesture. Two rules make that unreachable:
 * `perform` runs only in the idle phase (zoom excepted: it never writes the doc), and beginGesture is called only
 * from idle (pen, nudge) or press (translate, resize), which hold no gesture. Ending sets the phase to idle before
 * calling end() or cancel(), so a throw there leaves the controller idle, not wedged.
 */
import type {
  Board,
  BoardView,
  Box,
  Gesture,
  NewShape,
  Point,
  ShapeId,
  Style,
  Viewport,
} from "../../model/index.ts";
import {
  fitViewport,
  panBy,
  pinchViewport,
  snap,
  toBoard,
  wheelZoomFactor,
  zoomAt,
  type Size,
} from "./camera.ts";
import {
  boxOf,
  contentRect,
  dragFrame,
  handleAt,
  handlesFor,
  HIT_PX,
  hitTop,
  inside,
  rectBetween,
  rectOf,
  resizeTarget,
  selectionRect,
  type HandleId,
  type Handles,
  type Rect,
} from "./geometry.ts";
import { isArrowKey, keyAction, type Action, type KeySample, type Tool } from "./keys.ts";
import { naturalSize, newText, retextSize, scaleOf, TYPE_PX, type Measure } from "./text.ts";

export type BoxTool = Extract<Tool, "rect" | "ellipse" | "diamond" | "arrow">;

/** One pointer event, as the DOM boundary (stage.tsx) reads it. Stage-relative CSS px. */
export type PointerSample = {
  readonly pointerId: number;
  readonly kind: "mouse" | "pen" | "touch";
  /** 0 primary, 1 middle. Other buttons never reach the controller. */
  readonly button: number;
  readonly screen: Point;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly mod: boolean;
  /** The event's own timeStamp in ms. Passed to Gesture.update: the model's write throttle runs on event time. */
  readonly t: number;
};

export type InputEvent =
  | { readonly type: "stage"; readonly size: Size }
  | { readonly type: "down"; readonly p: PointerSample }
  /** One per coalesced sample, oldest first. The controller keeps what the phase needs: the latest, or every pen point. */
  | { readonly type: "move"; readonly p: PointerSample }
  | { readonly type: "up"; readonly p: PointerSample }
  /** pointercancel, or lostpointercapture without an up. */
  | { readonly type: "cancel"; readonly pointerId: number }
  | { readonly type: "dblclick"; readonly p: PointerSample }
  /** Deltas already in px. `zoom`: ctrl or meta held, which is also how Chrome and Firefox deliver a trackpad pinch. */
  | { readonly type: "wheel"; readonly screen: Point; readonly dx: number; readonly dy: number; readonly zoom: boolean }
  /** Safari's trackpad pinch (gesturechange): the scale since the previous event. */
  | { readonly type: "pinch"; readonly screen: Point; readonly factor: number }
  /** `t` is the event's own timeStamp, for the nudge gesture's write throttle. */
  | { readonly type: "key"; readonly down: boolean; readonly key: KeySample; readonly t: number }
  /** The window lost focus or the page was hidden: end everything that needs a button or a key held. */
  | { readonly type: "blur" }
  | { readonly type: "do"; readonly action: Action }
  | { readonly type: "text-input"; readonly draft: string }
  | { readonly type: "text-commit" };

/** The open text editor. Board units; the TextEditor converts with the viewport. */
export type TextEditing = {
  /** null: a new text, created on commit if the draft is not blank. */
  readonly target: ShapeId | null;
  /** Top-left of the box. */
  readonly at: Point;
  readonly draft: string;
  readonly fontSize: number;
  /** See text.ts scaleOf. 1 for new text. */
  readonly scale: number;
  /** naturalSize(draft) * scale: the textarea grows with what is typed. */
  readonly size: { readonly w: number; readonly h: number };
  readonly color: string;
};

/** What React renders from. A new object only when one of these changes, never per pointer move. */
export type UiState = {
  readonly tool: Tool;
  /** The style of the next shape. The style panel edits it and the selection together. */
  readonly style: Style;
  readonly editing: TextEditing | null;
};

/** What the overlay canvas paints besides the selection (which it derives from the view). New object on change. */
export type Overlay = {
  readonly marquee: Rect | null;
  readonly preview: NewShape | null;
  /** The text under the editor: the scene skips it, the overlay draws no outline for it. */
  readonly editing: ShapeId | null;
  readonly hover: HandleId | null;
};

export interface Controller {
  /** Returns whether the event was used, so the DOM boundary can preventDefault. False for a refused action. */
  send(event: InputEvent): boolean;
  /**
   * Applies what pointer moves made due, once per animation frame: at most one Gesture.update per frame (every
   * queued point for a pen) and one setViewport for a pan. The model republishes its view per update; the frame loop
   * paints once after this.
   */
  frame(): void;
  ui(): UiState;
  /** UiState changes. Not called per frame. */
  subscribe(listener: () => void): () => void;
  overlay(): Overlay;
  /** A CSS cursor for the stage. */
  cursor(): string;
}

export type ControllerOptions = { readonly measure: Measure };

export function createController(board: Board, options: ControllerOptions): Controller {
  return new LiveController(board, options.measure);
}

// ---------------------------------------------------------------------------------------------------------------

type PressTarget =
  | { readonly kind: "shape"; readonly id: ShapeId; readonly wasSelected: boolean }
  /** Down inside a multi-selection's box but on no shape: a drag moves the selection, a click clears it. */
  | { readonly kind: "selection" }
  | { readonly kind: "handle"; readonly handle: HandleId; readonly handles: Exclude<Handles, { kind: "none" }> }
  /** `base`: the selection a shift-marquee adds to. */
  | { readonly kind: "empty"; readonly base: ReadonlySet<ShapeId> }
  /** Text tool: a click opens the editor here. A drag does nothing more. */
  | { readonly kind: "text-point" };

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "press"; readonly pointerId: number; readonly down: PointerSample; readonly downBoard: Point; readonly target: PressTarget }
  | { readonly kind: "translate"; readonly pointerId: number; readonly downBoard: Point; readonly gesture: Gesture<"translate"> }
  | {
      readonly kind: "resize";
      readonly pointerId: number;
      readonly downBoard: Point;
      readonly handle: HandleId;
      readonly from: Box;
      readonly keepAspect: boolean;
      readonly gesture: Gesture<"resize">;
    }
  /** `last`: the last point accepted after thinning. Mutable: it moves with every accepted point. */
  | { readonly kind: "draw"; readonly pointerId: number; readonly gesture: Gesture<"draw">; last: Point }
  | { readonly kind: "marquee"; readonly pointerId: number; readonly downBoard: Point; readonly base: ReadonlySet<ShapeId> }
  | { readonly kind: "sizing"; readonly pointerId: number; readonly tool: BoxTool; readonly down: PointerSample; readonly downBoard: Point }
  | { readonly kind: "pan"; readonly pointerId: number; readonly down: Point; readonly start: Viewport }
  | {
      readonly kind: "pinch";
      readonly ids: readonly [number, number];
      readonly a0: Point;
      readonly b0: Point;
      readonly start: Viewport;
    }
  /** A held arrow key: one translate gesture, so one undo step. `dx`, `dy` and `held` move with every key press. */
  | { readonly kind: "nudge"; readonly gesture: Gesture<"translate">; readonly held: Set<string>; dx: number; dy: number };

/** Text editing is a mode, not a phase: while the editor is open no pointer phase runs. */
type Mode = { readonly kind: "canvas"; readonly phase: Phase } | { readonly kind: "text"; readonly editing: TextEditing };

const IDLE_PHASE: Phase = { kind: "idle" };
const IDLE: Mode = { kind: "canvas", phase: IDLE_PHASE };
const DEFAULT_STYLE: Style = { stroke: "#111111", fill: null, strokeWidth: 2 };
const NO_OVERLAY: Overlay = { marquee: null, preview: null, editing: null, hover: null };
/** Pen points closer than this many screen px to the last one are dropped before they reach the model. */
const PEN_MIN_PX = 2;
/** A click with a box tool makes a shape this many screen px wide. */
const CLICK_SIZE_PX = 100;
const DUPLICATE_OFFSET_PX = 16;
const DRAG_PX = 4;
const DRAG_TOUCH_PX = 8;
const ZOOM_STEP = 1.25;

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });

function ownsPointer(phase: Phase, pointerId: number): boolean {
  if (phase.kind === "idle" || phase.kind === "nudge") return false;
  return phase.kind === "pinch" ? phase.ids.includes(pointerId) : phase.pointerId === pointerId;
}

const sameValue = (a: object | null, b: object | null): boolean => {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
};

class LiveController implements Controller {
  private mode: Mode = IDLE;
  /** The latest sample of every pointer that is down. A pinch reads two. */
  private readonly pointers = new Map<number, PointerSample>();
  /** Thinned pen points not yet given to the draw gesture. */
  private strokeQueue: Array<{ readonly p: Point; readonly t: number }> = [];
  /** A continuous effect is due at the next frame: a move, a modifier change, or a viewport change mid-phase. */
  private due = false;
  private space = false;
  private stage: Size = { w: 0, h: 0 };
  private fitted = false;
  private state: UiState = { tool: "select", style: DEFAULT_STYLE, editing: null };
  private drawn: Overlay = NO_OVERLAY;
  private readonly listeners = new Set<() => void>();
  private readonly board: Board;
  private readonly measure: Measure;

  // No parameter properties: the package keeps erasableSyntaxOnly, because tsx and node --test run these files.
  constructor(board: Board, measure: Measure) {
    this.board = board;
    this.measure = measure;
  }

  send(event: InputEvent): boolean {
    switch (event.type) {
      case "stage":
        this.setStage(event.size);
        return false;
      case "down":
        return this.down(event.p);
      case "move":
        return this.move(event.p);
      case "up":
        return this.up(event.p);
      case "cancel":
        return this.cancelPointer(event.pointerId);
      case "dblclick":
        return this.doubleClick(event.p);
      case "wheel":
        this.setViewport(
          event.zoom
            ? zoomAt(this.view().viewport, event.screen, wheelZoomFactor(event.dy))
            : panBy(this.view().viewport, -event.dx, -event.dy),
        );
        return true;
      case "pinch":
        this.setViewport(zoomAt(this.view().viewport, event.screen, event.factor));
        return true;
      case "key":
        return event.down ? this.keyDown(event.key, event.t) : this.keyUp(event.key);
      case "blur":
        this.space = false;
        this.abandon();
        return false;
      case "do":
        return this.perform(event.action);
      case "text-input":
        return this.textInput(event.draft);
      case "text-commit":
        if (this.mode.kind !== "text") return false;
        this.commitText();
        return true;
    }
  }

  frame(): void {
    if (!this.due) return;
    this.due = false;
    const phase = this.phase();
    if (phase.kind === "idle" || phase.kind === "nudge") return;
    const v = this.view().viewport;
    if (phase.kind === "pinch") {
      const a = this.pointers.get(phase.ids[0]);
      const b = this.pointers.get(phase.ids[1]);
      if (a && b) this.board.setViewport(pinchViewport(phase.start, phase.a0, phase.b0, a.screen, b.screen));
      return;
    }
    const p = this.pointers.get(phase.pointerId);
    if (!p) return;
    switch (phase.kind) {
      case "translate": {
        const d = sub(toBoard(v, p.screen), phase.downBoard);
        phase.gesture.update({ dx: snap(d.x, v.zoom), dy: snap(d.y, v.zoom) }, p.t);
        return;
      }
      case "resize": {
        const d = sub(toBoard(v, p.screen), phase.downBoard);
        const to = resizeTarget(phase.from, phase.handle, d, { keepAspect: phase.keepAspect || p.shift, fromCenter: p.alt });
        phase.gesture.update({ to: snapBox(to, v.zoom) }, p.t);
        return;
      }
      case "draw":
        for (const q of this.strokeQueue) phase.gesture.update(q.p, q.t);
        this.strokeQueue = [];
        return;
      case "marquee":
        this.setOverlay({ marquee: rectBetween(phase.downBoard, toBoard(v, p.screen)) });
        return;
      case "sizing": {
        const frame = dragFrame(phase.tool, phase.downBoard, toBoard(v, p.screen), p.shift);
        this.setOverlay({ preview: boxShape(phase.tool, snapBox(frame, v.zoom), this.state.style) });
        return;
      }
      case "pan":
        this.board.setViewport(panBy(phase.start, p.screen.x - phase.down.x, p.screen.y - phase.down.y));
        return;
      case "press":
        return;
    }
  }

  ui(): UiState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  overlay(): Overlay {
    return this.drawn;
  }

  cursor(): string {
    const phase = this.phase();
    if (phase.kind === "pan") return "grabbing";
    if (this.space) return "grab";
    if (phase.kind === "resize") return handleCursor(phase.handle);
    if (phase.kind === "translate" || phase.kind === "nudge") return "move";
    if (this.mode.kind === "text") return "text";
    if (this.drawn.hover) return handleCursor(this.drawn.hover);
    if (this.state.tool === "text") return "text";
    return this.state.tool === "select" ? "default" : "crosshair";
  }

  // ---- pointer -------------------------------------------------------------------------------------------------

  private setStage(size: Size): void {
    this.stage = size;
    if (this.fitted || size.w === 0 || size.h === 0) return;
    this.fitted = true;
    const content = contentRect(this.view());
    if (content) this.board.setViewport(fitViewport(content, size, 1));
  }

  private down(p: PointerSample): boolean {
    if (this.mode.kind === "text") {
      this.commitText();
      return true;
    }
    const others = [...this.pointers.values()].filter((q) => q.pointerId !== p.pointerId);
    this.pointers.set(p.pointerId, p);
    if (this.phase().kind === "nudge") this.finishNudge();
    const phase = this.phase();
    if (phase.kind !== "idle") {
      const first = others.find((q) => q.kind === "touch" && ownsPointer(phase, q.pointerId));
      if (p.kind === "touch" && first) this.startPinch(first, p);
      return true;
    }
    const view = this.view();
    const v = view.viewport;
    const b = toBoard(v, p.screen);
    if (p.button === 1 || this.space) {
      this.mode = { kind: "canvas", phase: { kind: "pan", pointerId: p.pointerId, down: p.screen, start: v } };
      return true;
    }
    switch (this.state.tool) {
      case "select": {
        const handles = handlesFor(view);
        const handle = handleAt(handles, b, v.zoom);
        if (handle && handles.kind !== "none") return this.press(p, b, { kind: "handle", handle, handles });
        const id = hitTop(view, b, HIT_PX / v.zoom);
        if (id) {
          const wasSelected = view.selection.has(id);
          if (!wasSelected) this.board.select(p.shift ? [...view.selection, id] : [id]);
          return this.press(p, b, { kind: "shape", id, wasSelected });
        }
        const box = view.selection.size > 1 ? selectionRect(view) : undefined;
        if (box && b.x >= box.minX && b.x <= box.maxX && b.y >= box.minY && b.y <= box.maxY) {
          return this.press(p, b, { kind: "selection" });
        }
        return this.press(p, b, { kind: "empty", base: p.shift ? view.selection : new Set() });
      }
      case "text":
        return this.press(p, b, { kind: "text-point" });
      case "pen": {
        const gesture = this.board.beginGesture({ kind: "draw", style: this.state.style });
        const start = snapPoint(b, v.zoom);
        gesture.update(start, p.t);
        this.mode = { kind: "canvas", phase: { kind: "draw", pointerId: p.pointerId, gesture, last: b } };
        return true;
      }
      default:
        this.mode = { kind: "canvas", phase: { kind: "sizing", pointerId: p.pointerId, tool: this.state.tool, down: p, downBoard: b } };
        this.due = true;
        return true;
    }
  }

  private press(p: PointerSample, downBoard: Point, target: PressTarget): boolean {
    this.mode = { kind: "canvas", phase: { kind: "press", pointerId: p.pointerId, down: p, downBoard, target } };
    return true;
  }

  private startPinch(first: PointerSample, second: PointerSample): void {
    const start = this.view().viewport;
    this.abandon();
    this.pointers.set(first.pointerId, first);
    this.pointers.set(second.pointerId, second);
    this.mode = {
      kind: "canvas",
      phase: { kind: "pinch", ids: [first.pointerId, second.pointerId], a0: first.screen, b0: second.screen, start },
    };
  }

  private move(p: PointerSample): boolean {
    if (!this.pointers.has(p.pointerId)) {
      this.hover(p);
      return false;
    }
    this.pointers.set(p.pointerId, p);
    if (!ownsPointer(this.phase(), p.pointerId)) return false;
    this.track(p);
    return true;
  }

  /** What a sample of the pointer that owns the phase makes due. */
  private track(p: PointerSample): void {
    const phase = this.phase();
    const v = this.view().viewport;
    if (phase.kind === "press") {
      if (distance(p.screen, phase.down.screen) < (p.kind === "touch" ? DRAG_TOUCH_PX : DRAG_PX)) return;
      this.lift(phase);
    } else if (phase.kind === "draw") {
      const b = toBoard(v, p.screen);
      if (distance(b, phase.last) * v.zoom >= PEN_MIN_PX) {
        this.strokeQueue.push({ p: snapPoint(b, v.zoom), t: p.t });
        phase.last = b;
      }
    }
    this.due = true;
  }

  private hover(p: PointerSample): void {
    if (p.kind === "touch" || this.state.tool !== "select" || this.phase().kind !== "idle" || this.mode.kind !== "canvas") return;
    const view = this.view();
    const handle = handleAt(handlesFor(view), toBoard(view.viewport, p.screen), view.viewport.zoom);
    this.setOverlay({ hover: handle ?? null });
  }

  /** press -> the phase a drag of its target starts. The gesture's input at the next frame is the total since down. */
  private lift(press: Extract<Phase, { kind: "press" }>): void {
    const view = this.view();
    const { target } = press;
    switch (target.kind) {
      case "shape":
      case "selection":
        this.mode = {
          kind: "canvas",
          phase: {
            kind: "translate",
            pointerId: press.pointerId,
            downBoard: press.downBoard,
            gesture: this.board.beginGesture({ kind: "translate", ids: [...view.selection] }),
          },
        };
        return;
      case "handle": {
        const { handles } = target;
        const ids = handles.kind === "arrow" ? [handles.id] : [...view.selection];
        const from = handles.kind === "arrow" ? handles.arrow : handles.box;
        this.mode = {
          kind: "canvas",
          phase: {
            kind: "resize",
            pointerId: press.pointerId,
            downBoard: press.downBoard,
            handle: target.handle,
            from,
            keepAspect: handles.kind === "box" && handles.keepAspect,
            gesture: this.board.beginGesture({ kind: "resize", ids, from }),
          },
        };
        return;
      }
      case "empty":
        this.mode = { kind: "canvas", phase: { kind: "marquee", pointerId: press.pointerId, downBoard: press.downBoard, base: target.base } };
        return;
      case "text-point":
        return;
    }
  }

  private up(p: PointerSample): boolean {
    if (!ownsPointer(this.phase(), p.pointerId)) {
      this.pointers.delete(p.pointerId);
      return false;
    }
    this.pointers.set(p.pointerId, p);
    this.track(p);
    this.frame();
    const phase = this.phase();
    this.mode = IDLE;
    const v = this.view().viewport;
    switch (phase.kind) {
      case "press":
        this.click(phase, p);
        break;
      case "translate":
      case "resize":
      case "draw":
        phase.gesture.end();
        break;
      case "marquee": {
        const r = rectBetween(phase.downBoard, toBoard(v, p.screen));
        this.board.select([...phase.base, ...inside(this.view(), r)]);
        this.setOverlay({ marquee: null });
        break;
      }
      case "sizing": {
        const moved = distance(p.screen, phase.down.screen) >= DRAG_PX;
        const frame = moved
          ? dragFrame(phase.tool, phase.downBoard, toBoard(v, p.screen), p.shift)
          : clickFrame(phase.tool, phase.downBoard, CLICK_SIZE_PX / v.zoom);
        const { created } = this.board.dispatch({
          type: "create",
          shapes: [boxShape(phase.tool, snapBox(frame, v.zoom), this.state.style)],
        });
        this.board.select(created);
        this.setTool("select");
        this.setOverlay({ preview: null });
        break;
      }
      case "pan":
      case "pinch":
      case "idle":
      case "nudge":
        break;
    }
    this.pointers.delete(p.pointerId);
    return true;
  }

  /** press then up without a drag. */
  private click(press: Extract<Phase, { kind: "press" }>, p: PointerSample): void {
    const { target } = press;
    const view = this.view();
    switch (target.kind) {
      case "shape":
        if (!target.wasSelected) return;
        if (p.shift) this.board.select([...view.selection].filter((id) => id !== target.id));
        else this.board.select([target.id]);
        return;
      case "selection":
        this.board.select([]);
        return;
      case "empty":
        if (!p.shift) this.board.select([]);
        return;
      case "text-point": {
        const at = toBoard(view.viewport, p.screen);
        const zoom = view.viewport.zoom;
        this.openEditor({ target: null, at: { x: snap(at.x, zoom), y: snap(at.y - (TYPE_PX * 1.25) / 2 / zoom, zoom) } });
        return;
      }
      case "handle":
        return;
    }
  }

  private doubleClick(p: PointerSample): boolean {
    if (this.mode.kind !== "canvas" || this.phase().kind !== "idle") return false;
    if (this.state.tool !== "select" && this.state.tool !== "text") return false;
    const view = this.view();
    const b = toBoard(view.viewport, p.screen);
    const id = hitTop(view, b, HIT_PX / view.viewport.zoom);
    if (id === undefined) {
      this.openEditor({ target: null, at: { x: snap(b.x, view.viewport.zoom), y: snap(b.y, view.viewport.zoom) } });
      return true;
    }
    if (view.shapes.get(id)?.kind !== "text") return false;
    this.board.select([id]);
    this.openEditor({ target: id });
    return true;
  }

  /** pointercancel or lostpointercapture: the phase that owns the pointer ends as if Escape had been pressed. */
  private cancelPointer(pointerId: number): boolean {
    if (!ownsPointer(this.phase(), pointerId)) {
      this.pointers.delete(pointerId);
      return false;
    }
    this.abandon();
    return true;
  }

  /**
   * Ends whatever the pointer was doing without keeping it. Idempotent: from idle it does nothing. Text mode is left
   * alone: the editor keeps its draft.
   */
  private abandon(): void {
    const phase = this.phase();
    if (this.mode.kind === "canvas") this.mode = IDLE;
    this.strokeQueue = [];
    this.pointers.clear();
    this.due = false;
    this.setOverlay({ marquee: null, preview: null });
    if (phase.kind === "translate" || phase.kind === "resize" || phase.kind === "draw" || phase.kind === "nudge") {
      phase.gesture.cancel();
    }
  }

  // ---- keys and actions ----------------------------------------------------------------------------------------

  private keyDown(k: KeySample, t: number): boolean {
    if (k.key === " ") {
      if (!k.repeat) this.space = true;
      return true;
    }
    if (k.key === "Escape") return this.escape();
    if (k.key === "Shift" || k.key === "Alt") return this.reaim(k);
    const action = keyAction(k);
    if (!action) return false;
    if (action.type === "nudge" && isArrowKey(k.key)) return this.nudge(k.key, action.dx, action.dy, t);
    return this.perform(action);
  }

  private keyUp(k: KeySample): boolean {
    if (k.key === " ") {
      this.space = false;
      return true;
    }
    if (k.key === "Shift" || k.key === "Alt") return this.reaim(k);
    const phase = this.phase();
    if (phase.kind === "nudge" && isArrowKey(k.key)) {
      phase.held.delete(k.key);
      if (phase.held.size === 0) this.finishNudge();
      return true;
    }
    return false;
  }

  private escape(): boolean {
    if (this.mode.kind === "text") {
      this.commitText();
      return true;
    }
    if (this.phase().kind !== "idle") {
      this.abandon();
      return true;
    }
    const clears = this.view().selection.size > 0;
    if (clears) this.board.select([]);
    if (this.state.tool === "select") return clears;
    this.setTool("select");
    return true;
  }

  /** Shift and Alt change what a live drag means without a pointer move: the pointer's sample takes the new flags. */
  private reaim(k: KeySample): boolean {
    const phase = this.phase();
    if (phase.kind === "idle" || phase.kind === "nudge" || phase.kind === "pinch") return false;
    const p = this.pointers.get(phase.pointerId);
    if (p) this.pointers.set(p.pointerId, { ...p, shift: k.shift, alt: k.alt });
    this.due = true;
    return false;
  }

  /** A held arrow key: the first press begins one translate gesture, every repeat moves it further. */
  private nudge(key: string, dx: number, dy: number, t: number): boolean {
    const phase = this.phase();
    if (phase.kind === "nudge") {
      phase.held.add(key);
      phase.dx += dx;
      phase.dy += dy;
      phase.gesture.update({ dx: phase.dx, dy: phase.dy }, t);
      return true;
    }
    if (this.mode.kind !== "canvas" || phase.kind !== "idle") return false;
    const ids = [...this.view().selection];
    if (ids.length === 0) return false;
    const gesture = this.board.beginGesture({ kind: "translate", ids });
    this.mode = { kind: "canvas", phase: { kind: "nudge", gesture, held: new Set([key]), dx, dy } };
    gesture.update({ dx, dy }, t);
    return true;
  }

  private finishNudge(): void {
    const phase = this.phase();
    if (phase.kind !== "nudge") return;
    this.mode = IDLE;
    phase.gesture.end();
  }

  private setViewport(next: Viewport): void {
    this.board.setViewport(next);
    if (this.phase().kind !== "idle") this.due = true;
  }

  /**
   * The only door to board commands. Refuses (returns false) unless the phase is idle; zoom is always allowed.
   * A selection-less delete, duplicate or reorder returns false too: nothing happened.
   */
  private perform(action: Action): boolean {
    if (action.type === "zoom") return this.zoom(action.to);
    if (this.mode.kind === "text") this.commitText();
    if (this.phase().kind !== "idle") return false;
    const view = this.view();
    const ids = [...view.selection];
    switch (action.type) {
      case "tool":
        this.setTool(action.tool);
        if (action.tool !== "select") this.board.select([]);
        return true;
      case "undo":
        this.board.undo();
        return true;
      case "redo":
        this.board.redo();
        return true;
      case "delete":
        if (ids.length === 0) return false;
        this.board.dispatch({ type: "remove", ids });
        return true;
      case "duplicate": {
        if (ids.length === 0) return false;
        const offset = snap(DUPLICATE_OFFSET_PX / view.viewport.zoom, view.viewport.zoom);
        this.board.select(this.board.dispatch({ type: "duplicate", ids, dx: offset, dy: offset }).created);
        return true;
      }
      case "reorder":
        if (ids.length === 0) return false;
        this.board.dispatch({ type: "reorder", ids, to: action.to });
        return true;
      case "nudge":
        if (ids.length === 0) return false;
        this.board.dispatch({ type: "move", ids, dx: action.dx, dy: action.dy });
        return true;
      case "style":
        if (ids.length > 0) this.board.dispatch({ type: "style", ids, edit: action.edit });
        this.state = { ...this.state, style: { ...this.state.style, ...action.edit } };
        this.emit();
        return true;
      case "selectAll":
        this.board.select(view.order);
        return true;
      case "editText": {
        const [only] = ids;
        if (ids.length !== 1 || view.shapes.get(only!)?.kind !== "text") return false;
        this.openEditor({ target: only! });
        return true;
      }
    }
  }

  private zoom(to: "in" | "out" | "reset" | "fit"): boolean {
    const view = this.view();
    const v = view.viewport;
    const center = { x: this.stage.w / 2, y: this.stage.h / 2 };
    if (to === "fit") {
      const content = contentRect(view);
      if (content) this.setViewport(fitViewport(content, this.stage, 1));
    } else {
      this.setViewport(zoomAt(v, center, to === "in" ? ZOOM_STEP : to === "out" ? 1 / ZOOM_STEP : 1 / v.zoom));
    }
    return true;
  }

  // ---- text ----------------------------------------------------------------------------------------------------

  /** Opens the editor over an existing text, or at a point for a new one. */
  private openEditor(target: { readonly target: ShapeId } | { readonly target: null; readonly at: Point }): void {
    const view = this.view();
    let editing: Omit<TextEditing, "size">;
    if (target.target === null) {
      const fontSize = Math.round((TYPE_PX / view.viewport.zoom) * 100) / 100;
      editing = { target: null, at: target.at, draft: "", fontSize, scale: 1, color: this.state.style.stroke };
    } else {
      const shape = view.shapes.get(target.target);
      if (shape?.kind !== "text") return;
      const r = rectOf(shape);
      editing = {
        target: shape.id,
        at: { x: r.minX, y: r.minY },
        draft: shape.text,
        fontSize: shape.fontSize,
        scale: scaleOf(shape) || 1,
        color: shape.stroke,
      };
    }
    this.enterText({ ...editing, size: this.textSize(editing, editing.draft) });
  }

  private textSize(e: Omit<TextEditing, "size">, draft: string): TextEditing["size"] {
    const natural = naturalSize(draft, e.fontSize, this.measure);
    return { w: natural.w * e.scale, h: natural.h * e.scale };
  }

  private textInput(draft: string): boolean {
    if (this.mode.kind !== "text") return false;
    this.enterText({ ...this.mode.editing, draft, size: this.textSize(this.mode.editing, draft) });
    return true;
  }

  private enterText(editing: TextEditing): void {
    this.mode = { kind: "text", editing };
    this.state = { ...this.state, editing };
    this.setOverlay({ editing: editing.target });
    this.emit();
  }

  /** Closes the editor and writes what it holds, as one command. */
  private commitText(): void {
    if (this.mode.kind !== "text") return;
    const e = this.mode.editing;
    this.mode = IDLE;
    this.state = { ...this.state, editing: null };
    this.setOverlay({ editing: null });
    this.emit();
    const blank = e.draft.trim() === "";
    if (e.target === null) {
      if (blank) return;
      const { created } = this.board.dispatch({
        type: "create",
        shapes: [newText(e.at, e.draft, e.fontSize, this.state.style, this.measure)],
      });
      this.board.select(created);
      this.setTool("select");
      return;
    }
    const shape = this.view().shapes.get(e.target);
    if (shape?.kind !== "text") return;
    if (blank) this.board.dispatch({ type: "remove", ids: [shape.id] });
    else if (e.draft !== shape.text) {
      this.board.dispatch({ type: "style", ids: [shape.id], edit: { text: e.draft, ...retextSize(shape, e.draft, this.measure) } });
    }
  }

  // ---- helpers -------------------------------------------------------------------------------------------------

  private view(): BoardView {
    return this.board.view();
  }

  private phase(): Phase {
    return this.mode.kind === "canvas" ? this.mode.phase : IDLE_PHASE;
  }

  private setTool(tool: Tool): void {
    if (this.state.tool === tool) return;
    this.state = { ...this.state, tool };
    this.emit();
  }

  /** Keeps the same object when nothing changed, so the renderer can skip a repaint. */
  private setOverlay(change: Partial<Overlay>): void {
    const next = { ...this.drawn, ...change };
    const same =
      sameValue(next.marquee, this.drawn.marquee) &&
      sameValue(next.preview, this.drawn.preview) &&
      next.editing === this.drawn.editing &&
      next.hover === this.drawn.hover;
    if (!same) this.drawn = next;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function handleCursor(handle: HandleId): string {
  switch (handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "start":
    case "end":
      return "crosshair";
  }
}

const snapPoint = (p: Point, zoom: number): Point => ({ x: snap(p.x, zoom), y: snap(p.y, zoom) });

/** Snaps the corners, not the sizes, so the box edges land on the grid. */
function snapBox(b: Box, zoom: number): Box {
  const x = snap(b.x, zoom);
  const y = snap(b.y, zoom);
  return { x, y, w: snap(b.x + b.w, zoom) - x, h: snap(b.y + b.h, zoom) - y };
}

/** A click with a box tool: a shape of `size` centered on the pointer. An arrow runs right from its center. */
function clickFrame(tool: BoxTool, at: Point, size: number): Box {
  return { x: at.x - size / 2, y: tool === "arrow" ? at.y : at.y - size / 2, w: size, h: tool === "arrow" ? 0 : size };
}

/** The shape a box tool creates over `frame`, in `style`. Boxes are normalized; an arrow keeps its direction in the signs. */
export function boxShape(tool: BoxTool, frame: Box, style: Style): NewShape {
  if (tool === "arrow") return { kind: "arrow", ...frame, ...style, fill: null };
  return { kind: tool, ...boxOf(rectOf(frame)), ...style };
}
