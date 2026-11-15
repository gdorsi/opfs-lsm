/**
 * Text boxes. The model never measures text, so the UI does, once per commit, and writes the box with the text.
 *
 * The rule: a text shape's stored frame is the truth for where it is and how big it looks. The painter fits the text
 * to the frame without measuring:
 *   fontPx = |h| / (lines * LINE_HEIGHT)           the frame's height sets the visual size
 *   each line is drawn with maxWidth = |w|          a frame narrower than the text squeezes it
 * `fontSize` is the size the text was typed at. It sets the natural box a commit measures, and with it the scale
 * a resize has applied:  scale = |h| / (lines * fontSize * LINE_HEIGHT).
 *
 * So a resize (which only changes the frame, as the model's resize does for every kind) scales text, hit testing and
 * culling read the frame like any other kind, and only text create and text edit measure. Nothing caches widths.
 */
import type { NewShape, Point, Shape, Style } from "../../model/index.ts";

export type TextShape = Extract<Shape, { kind: "text" }>;

/** Width in px of one line at `fontPx` in FONT. The browser's is canvasMeasure() in paint.ts; tests pass a fixed-pitch fake. */
export type Measure = (line: string, fontPx: number) => number;

export const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
export const LINE_HEIGHT = 1.25;
/** The size new text appears at on screen, in px. fontSize = TYPE_PX / zoom at creation. */
export const TYPE_PX = 20;

export const linesOf = (text: string): string[] => text.split("\n");

/** The box `text` takes at `fontSize`, unscaled. An empty line still holds a caret: at least half an em wide. */
export function naturalSize(text: string, fontSize: number, measure: Measure): { w: number; h: number } {
  const lines = linesOf(text);
  return {
    w: Math.max(fontSize * 0.5, ...lines.map((line) => measure(line, fontSize))),
    h: lines.length * fontSize * LINE_HEIGHT,
  };
}

/** How much a resize has scaled this text since it was typed. 1 for text that was never resized. */
export function scaleOf(shape: TextShape): number {
  return Math.abs(shape.h) / (linesOf(shape.text).length * shape.fontSize * LINE_HEIGHT);
}

/** The font size the painter draws with, in board units. Never measures. */
export function fontPxOf(shape: Pick<TextShape, "text" | "h">): number {
  return Math.abs(shape.h) / (linesOf(shape.text).length * LINE_HEIGHT);
}

/**
 * The frame an edited text takes: the natural size of the new text times the shape's current scale, keeping the
 * signs of w and h, so the corner at (x, y) stays put even on a flipped box. Sent with the text as one `style`
 * command, so the edit is one undo step and the frame never lags the text.
 */
export function retextSize(shape: TextShape, text: string, measure: Measure): { w: number; h: number } {
  const scale = scaleOf(shape) || 1;
  const natural = naturalSize(text, shape.fontSize, measure);
  return { w: Math.sign(shape.w || 1) * natural.w * scale, h: Math.sign(shape.h || 1) * natural.h * scale };
}

/** A new text shape with its top-left at `at`, typed at `fontSize`. fill is null: a text's fill is a background. */
export function newText(at: Point, text: string, fontSize: number, style: Style, measure: Measure): NewShape {
  return {
    kind: "text",
    x: at.x,
    y: at.y,
    ...naturalSize(text, fontSize, measure),
    text,
    fontSize,
    stroke: style.stroke,
    fill: null,
    strokeWidth: style.strokeWidth,
  };
}
