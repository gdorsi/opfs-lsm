import type { NewShape, Point, Shape, Style } from "../../model/index.ts";

export type TextShape = Extract<Shape, { kind: "text" }>;

export type Measure = (line: string, fontPx: number) => number;

export const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
export const LINE_HEIGHT = 1.25;
export const TYPE_PX = 20;

export const linesOf = (text: string): string[] => text.split("\n");

export function naturalSize(text: string, fontSize: number, measure: Measure): { w: number; h: number } {
  const lines = linesOf(text);
  return {
    w: Math.max(fontSize * 0.5, ...lines.map((line) => measure(line, fontSize))),
    h: lines.length * fontSize * LINE_HEIGHT,
  };
}

export function scaleOf(shape: TextShape): number {
  return Math.abs(shape.h) / (linesOf(shape.text).length * shape.fontSize * LINE_HEIGHT);
}

export function fontPxOf(shape: Pick<TextShape, "text" | "h">): number {
  return Math.abs(shape.h) / (linesOf(shape.text).length * LINE_HEIGHT);
}

export function retextSize(shape: TextShape, text: string, measure: Measure): { w: number; h: number } {
  const scale = scaleOf(shape) || 1;
  const natural = naturalSize(text, shape.fontSize, measure);
  return { w: Math.sign(shape.w || 1) * natural.w * scale, h: Math.sign(shape.h || 1) * natural.h * scale };
}

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
