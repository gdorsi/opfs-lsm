export type PagesErrorKind =
  /** The caller passed something the model refuses before any change. */
  | "invalid"
  /** A storage read or write failed. */
  | "storage";

export class PagesError extends Error {
  readonly kind: PagesErrorKind;

  constructor(kind: PagesErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PagesError";
    this.kind = kind;
  }
}
