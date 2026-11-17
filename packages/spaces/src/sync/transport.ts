/**
 * A duplex byte channel to the server. The engine owns reconnects and
 * backoff. A transport only opens, sends and reports.
 */

export interface Connection {
  send(frame: Uint8Array): void;
  close(): void;
}

export type ConnectionEvents = {
  readonly onOpen: () => void;
  readonly onFrame: (frame: Uint8Array) => void;
  /** Exactly once per connection, after which `send` does nothing. */
  readonly onClose: (reason: "closed" | "error") => void;
};

export interface Transport {
  connect(events: ConnectionEvents): Connection;
}

/** A WebSocket with `binaryType = "arraybuffer"`, one message per frame. Refuses `ws://` outside localhost: member tokens are bearer secrets. */
export declare function websocket(url: string): Transport;
