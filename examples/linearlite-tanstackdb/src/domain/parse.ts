import type { PriorityCode, StatusCode } from "./model.ts";

export class WireError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "WireError";
    this.status = status;
  }
}

export const fail = (message: string): never => {
  throw new WireError(message);
};

export type Parse<V> = (v: unknown, what: string) => V;

export function id(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) return fail(`${what} must be 1-64 characters of [A-Za-z0-9_-]`);
  return v;
}
export function text(max: number, min = 0): Parse<string> {
  return (v, what) => {
    if (typeof v !== "string" || v.length < min || v.length > max) return fail(`${what} must be a string of ${min}-${max} characters`);
    return v;
  };
}
export function code(v: unknown, what: string): StatusCode & PriorityCode {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 4) return fail(`${what} must be an integer 0-4`);
  return v as StatusCode & PriorityCode;
}
export function bool(v: unknown, what: string): boolean {
  return typeof v === "boolean" ? v : fail(`${what} must be a boolean`);
}
export function kanbanorder(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^[0-9A-Za-z]{1,64}$/.test(v)) return fail(`${what} must be 1-64 alphanumeric characters`);
  return v;
}
