/**
 * Identifiers. Every id is random bytes shown as base64url text, and the
 * text form is what apps store, put in URLs and pass around.
 *
 * A record id and a file id start with their space's tag, the first 8 bytes
 * of the space id. That puts the space into the id, so:
 *   - a record can never move between spaces (its key, its encryption key,
 *     and its server partition all follow from the id);
 *   - a ref (`ref("lists")`) needs only the id to resolve, with no space
 *     lookup;
 *   - the records of one space in one collection are one kv prefix
 *     (`local/keys.ts` `recordBounds`).
 */

import { SpacesError } from "./errors.js";
import { concat, fromBase64url, toBase64url, utf8 } from "./bytes.js";

declare const brand: unique symbol;
export type Brand<T, B> = T & { readonly [brand]: B };

/** 16 random bytes, 22 chars. The personal space's id is derived from the account secret instead (`space/crypto.ts` personalSpace). */
export type SpaceId = Brand<string, "SpaceId">;

/** spaceTag(8) || random(8), 22 chars. `C` is the collection name, so a `RecordId<"lists">` cannot be passed where a todo id is expected. */
export type RecordId<C extends string = string> = Brand<string, `RecordId:${C}`>;

/** spaceTag(8) || random(8), 22 chars. */
export type FileId = Brand<string, "FileId">;

/**
 * A member of one space: base64url of `tokenId(memberToken(accountSecret,
 * space))` (`space/crypto.ts`), 16 bytes. The same account has a different
 * `MemberId` in each space, so the server cannot link one person across
 * spaces by id.
 */
export type MemberId = Brand<string, "MemberId">;

/** Byte forms used inside the package. Never on the public surface. */
export type SpaceTag = Brand<Uint8Array, "SpaceTag">; // 8 bytes
export type RecordKeyId = Brand<Uint8Array, "RecordKeyId">; // 16 bytes
export type FileKeyId = Brand<Uint8Array, "FileKeyId">; // 16 bytes
export type SpaceBytes = Brand<Uint8Array, "SpaceBytes">; // 16 bytes

const TAG_BYTES = 8;
const ID_BYTES = 16;
/** base64url chars of 16 bytes. */
const ID_CHARS = 22;
/** base64url chars that hold the first 8 bytes. */
const TAG_CHARS = 11;

// The brand constructors below cast inside this module only: a string or
// byte array becomes an id here and nowhere else.

function randomId(tag: Uint8Array): string {
  const out = new Uint8Array(ID_BYTES);
  out.set(tag);
  crypto.getRandomValues(out.subarray(TAG_BYTES));
  return toBase64url(out);
}

/** True for the text of 16 bytes in canonical base64url. */
export function isIdText(text: unknown): text is string {
  if (typeof text !== "string" || text.length !== ID_CHARS) return false;
  const bytes = fromBase64url(text);
  return bytes !== undefined && toBase64url(bytes) === text;
}

/** A random record id in `space`. */
export function newRecordId<C extends string>(space: SpaceId): RecordId<C> {
  return randomId(tagOf(space)) as RecordId<C>;
}

/**
 * The same id on every device for the same (space, collection, key), for
 * "one per key" records such as a member's profile. Two devices that create
 * it offline merge field by field instead of making two records. Delete is
 * terminal, so a keyed record must not be deleted if it can be wanted back.
 */
export async function keyedRecordId<C extends string>(space: SpaceId, collection: C, key: string): Promise<RecordId<C>> {
  const zero = Uint8Array.of(0);
  const digest = await crypto.subtle.digest("SHA-256", concat(utf8(space), zero, utf8(collection), zero, utf8(key)));
  return toBase64url(concat(tagOf(space), new Uint8Array(digest, 0, TAG_BYTES))) as RecordId<C>;
}

export function newFileId(space: SpaceId): FileId {
  return randomId(tagOf(space)) as FileId;
}

/** The 8-byte tag that starts every record and file id of the space. */
export function tagOf(id: SpaceId | RecordId | FileId): SpaceTag {
  return fromBase64url(id.slice(0, TAG_CHARS))! as SpaceTag;
}

/** Parse an id that came from outside (a URL, a ref field). Throws SpacesError "validation". */
export function parseRecordId<C extends string>(text: string, collection: C): RecordId<C> {
  if (!isIdText(text)) throw new SpacesError("validation", `not a ${collection} id`, { collection });
  return text as RecordId<C>;
}

export function recordBytes(id: RecordId): RecordKeyId {
  return fromBase64url(id)! as RecordKeyId;
}
export function fileBytes(id: FileId): FileKeyId {
  return fromBase64url(id)! as FileKeyId;
}
export function spaceBytes(id: SpaceId): SpaceBytes {
  return fromBase64url(id)! as SpaceBytes;
}

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const SUFFIX = 4;
const FIRST = "a0";
const SMALLEST = "A" + "0".repeat(26);

/** Chars of an integer part, head included: 'a'..'z' take 2..27, 'Z'..'A' take 2..27 for the negatives. */
function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  return -1;
}

/** The variable-length integer a position starts with. */
function integerOf(position: string): string {
  return position.slice(0, integerLength(position[0]!));
}

function increment(integer: string): string | undefined {
  const head = integer[0]!;
  const digits = integer.slice(1).split("");
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]!) + 1;
    if (d === BASE) digits[i] = DIGITS[0]!;
    else {
      digits[i] = DIGITS[d]!;
      carry = false;
    }
  }
  if (!carry) return head + digits.join("");
  if (head === "Z") return FIRST;
  if (head === "z") return undefined;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > "a") digits.push(DIGITS[0]!);
  else digits.pop();
  return next + digits.join("");
}

function decrement(integer: string): string | undefined {
  const head = integer[0]!;
  const digits = integer.slice(1).split("");
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]!) - 1;
    if (d === -1) digits[i] = DIGITS[BASE - 1]!;
    else {
      digits[i] = DIGITS[d]!;
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join("");
  if (head === "A") return undefined;
  if (head === "a") return "Z" + DIGITS[BASE - 1]!;
  const next = String.fromCharCode(head.charCodeAt(0) - 1);
  if (next < "Z") digits.push(DIGITS[BASE - 1]!);
  else digits.pop();
  return next + digits.join("");
}

/**
 * A digit string strictly between `a` and `b` (`b` absent: no upper bound)
 * that is never a prefix of `b`, so appending to it keeps it below `b`.
 * Neither input ends in the zero digit. `a` reads as if padded with zeros.
 */
function midpoint(a: string, b: string | undefined): string {
  if (b !== undefined) {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : DIGITS.indexOf(a[0]!);
  const digitB = b === undefined ? BASE : DIGITS.indexOf(b[0]!);
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)]!;
  // Consecutive digits: stay on a's side, which is below b whatever follows.
  return DIGITS[digitA]! + midpoint(a.slice(1), undefined);
}

function checkPosition(position: string | undefined, what: string): void {
  if (position === undefined) return;
  const n = position === "" ? -1 : integerLength(position[0]!);
  const fraction = position.slice(n);
  const ok = n > 0 && position.length >= n && [...position].every((c) => DIGITS.includes(c)) && !fraction.endsWith("0");
  if (!ok) throw new SpacesError("validation", `${what} is not a position made by between()`);
}

/** The position, without its random suffix, that sorts between `a` and `b` and is no prefix of `b`. */
function base(a: string | undefined, b: string | undefined): string {
  if (a === undefined && b === undefined) return FIRST;
  if (a === undefined) {
    const ib = integerOf(b!);
    const lower = ib === SMALLEST ? undefined : decrement(ib);
    return lower ?? ib + midpoint("", b!.slice(ib.length));
  }
  const ia = integerOf(a);
  const fa = a.slice(ia.length);
  if (b === undefined) return increment(ia) ?? ia + midpoint(fa, undefined);
  const ib = integerOf(b);
  if (ia === ib) return ia + midpoint(fa, b.slice(ib.length));
  const next = increment(ia);
  if (next !== undefined && next < b && !b.startsWith(next)) return next;
  return ia + midpoint(fa, undefined);
}

/**
 * Fractional index for ordered lists. Returns a string that sorts strictly
 * between `before` and `after` (either may be absent), with 4 random
 * trailing chars so two devices inserting at the same spot get distinct
 * positions. Order ties, which need equal random suffixes, fall back to
 * the record id, because every index ends with it.
 *
 * A position starts with a variable-length integer (a head letter that
 * gives the digit count, then base-62 digits), so appending or prepending
 * n items costs about log62(n) chars: after n appends or n prepends a
 * position is at most 6 + log62(n) chars, suffix included (20,000 take 8).
 * Only inserting between two close neighbours, again and again at one spot,
 * grows a position, by about one char per 5 such inserts.
 *
 * This replaces CoList: a list is a collection with a `position` field and
 * an index ending in it. A concurrent move of one item keeps one of the
 * moves (per-field last write wins), and an item never duplicates.
 */
export function between(before?: string, after?: string): string {
  checkPosition(before, "before");
  checkPosition(after, "after");
  if (before !== undefined && after !== undefined && before >= after) {
    throw new SpacesError("validation", "before must sort below after");
  }
  const random = crypto.getRandomValues(new Uint8Array(SUFFIX));
  let suffix = "";
  for (let i = 0; i < SUFFIX; i++) {
    // The last digit is never the zero digit, so a fraction never ends in it.
    const r = random[i]!;
    suffix += i === SUFFIX - 1 ? DIGITS[1 + (r % (BASE - 1))]! : DIGITS[r % BASE]!;
  }
  return base(before, after) + suffix;
}
