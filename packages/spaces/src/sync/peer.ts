/**
 * Peer-to-peer sync (deferred, after v1). Two members' devices exchange
 * record states directly, over any `Transport`: a WebRTC data channel with
 * app-provided signaling, or a LAN WebSocket.
 *
 * Peers can merge, so they need no compare-and-set and no cursor. A
 * session reconciles state, the way the server never has to:
 *
 *   1. Each side scans the space's records and tombstones (`73 01 <coll>
 *      <tag>` and `73 02 <tag>`, keys and the meta slice only) and folds
 *      them into 256 bucket fingerprints. The bucket is the first random
 *      byte of the record id after the space tag. A bucket's fingerprint is
 *      the sum mod 2^64 of H64(record id || digest), where the digest of a
 *      record is H64 of its sorted (field, stamp) pairs and the digest of a
 *      tombstone is a constant.
 *   2. Each side sends the fingerprints. For every bucket that differs, both
 *      send their (record id, digest) lists.
 *   3. Each side sends the states whose digest differs or that the other
 *      lacks, sealed as `Envelope`s under the space key. The receiver
 *      applies them with `LocalStore.applyRemote` as a `peer` page.
 *
 * Merges are idempotent, so sending a state the other side already covers
 * writes nothing. Nothing is maintained per write: the fingerprints are a
 * scan at session start, which is cheap at small-app sizes. Because the
 * unit is state, a device that lost writes to a power loss, or a peer that
 * never saw some writes, simply differs in a bucket. There is no log
 * position to reuse and no cursor to fall behind.
 *
 * Live: after reconciling, each side forwards every record it applies or
 * writes to its connected peers. An item already applied merges to no
 * change and is not forwarded again, so flooding stops.
 *
 * Trust: holding the space key is the only proof a peer can give. Each side
 * proves it with an HMAC over a direction byte and both nonces, keyed by a
 * value derived from the space key, so a peer that lacks the key learns
 * nothing and a proof cannot be reflected into another session. Roles live
 * on the server, so peers cannot check them: a reader or a removed member
 * that still holds the key is a full peer, and a writer that forwards its
 * states launders them past the server's role check. Peer sync is therefore
 * for the devices of one account, or for a group that trusts every key
 * holder.
 *
 * Forwarding to the server: a state that came from a peer and changed the
 * record stays in the outbox, so the device pushes it like its own write.
 * The server's compare-and-set drops the copies several peers push.
 */

import type { SpaceBytes } from "../ids.js";
import type { Envelope } from "./protocol.js";

/** 256 sums, one per bucket, u64 each. */
export type Fingerprints = BigUint64Array;

export type PeerMessage =
  | { readonly t: "peerHello"; readonly space: SpaceBytes; readonly nonce: Uint8Array }
  /** HMAC-SHA-256(HKDF(spaceKey, "spaces/peer-proof"), direction || own nonce || other nonce); direction is 1 for the side that sent the first hello, 2 for the other. */
  | { readonly t: "peerProof"; readonly space: SpaceBytes; readonly proof: Uint8Array }
  | { readonly t: "peerFingerprints"; readonly space: SpaceBytes; readonly buckets: Fingerprints }
  | {
      readonly t: "peerDigests";
      readonly space: SpaceBytes;
      readonly bucket: number;
      readonly entries: readonly { readonly id: Uint8Array; readonly digest: bigint }[];
    }
  /** Items sealed under the space key. `rev` fields are 0: peers have no server revs. */
  | { readonly t: "peerStates"; readonly space: SpaceBytes; readonly items: readonly Envelope[] };
