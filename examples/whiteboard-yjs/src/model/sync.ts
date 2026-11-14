import * as Y from "yjs";
import type { Sync } from "./types.ts";

/**
 * The part of BroadcastChannel the relay uses. The browser's constructor and Node's both fit as they are. The
 * listener is registered with addEventListener, whose method form TypeScript compares loosely; an `onmessage`
 * property would need a cast.
 */
export interface Channel {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  close(): void;
}
export type ChannelConstructor = new (name: string) => Channel;

type Message =
  /** A tab that just opened the doc says what it has. Every other tab answers with an update of what it lacks. */
  | { readonly type: "hello"; readonly stateVector: Uint8Array }
  /** A new update of the doc, or the answer to a hello. Applying one twice changes nothing. */
  | { readonly type: "update"; readonly update: Uint8Array };

/** The origin of every update the relay applies, so it is never posted back. */
const RELAY = Symbol("whiteboard-yjs.relay");

/**
 * Relays a doc between the tabs of one origin on the channel `whiteboard-yjs/<docName>`. It posts every update
 * the doc emits except those it applied itself, and says hello with its state vector when it starts, so a tab
 * that opens late gets the diff. It knows nothing of storage: every adapter gets the same mechanism, and the
 * doc's own update events carry what arrives to whatever storage listens to the doc.
 *
 * The channel constructor is injected, so the model touches no global and Node tests pass Node's.
 */
export function broadcastSync(Channel: ChannelConstructor): Sync {
  return (docName, doc) => {
    const channel = new Channel(`whiteboard-yjs/${docName}`);
    const post = (message: Message) => channel.postMessage(message);

    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin !== RELAY) post({ type: "update", update });
    };
    const onMessage = ({ data }: { readonly data: unknown }) => {
      const message = parse(data);
      if (!message) return;
      try {
        if (message.type === "hello") post({ type: "update", update: Y.encodeStateAsUpdate(doc, message.stateVector) });
        else Y.applyUpdate(doc, message.update, RELAY);
      } catch {
        // Bytes that are not a Yjs update or state vector come from outside the model. Ignoring them is all there is to do.
      }
    };

    doc.on("update", onUpdate);
    channel.addEventListener("message", onMessage);
    post({ type: "hello", stateVector: Y.encodeStateVector(doc) });
    return () => {
      doc.off("update", onUpdate);
      channel.removeEventListener("message", onMessage);
      channel.close();
    };
  };
}

/** The boundary: anything another context posted on the channel. */
function parse(data: unknown): Message | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { type, stateVector, update } = data as Record<string, unknown>;
  if (type === "hello" && stateVector instanceof Uint8Array) return { type, stateVector };
  if (type === "update" && update instanceof Uint8Array) return { type, update };
  return undefined;
}
