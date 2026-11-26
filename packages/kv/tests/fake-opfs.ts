type Handles = "writable" | "sync" | "none" | "throws";

/** What one fake origin shares across its directories. */
export type FakeOrigin = {
  /**
   * What a file handle has: "writable" as Chrome, Firefox and Safari 26,
   * "sync" as Safari 18.6 and a dedicated Worker, "none" as a SharedWorker
   * the spec describes, and "throws" for a sync access handle that is there
   * and refuses.
   */
  readonly handles: Handles;
  /** Bytes a sync access handle may still write. A remove, a truncate and a replaced file give theirs back. */
  free: number;
  /** At the limit, write what fits and return the count, as a full disk does. Otherwise throw `QuotaExceededError`. */
  short: boolean;
  /** Every entry a directory removed, by name, in order. */
  readonly removals: string[];
  /** Sync access handles opened and not yet closed. */
  open: number;
};

type FakeFile = {
  readonly kind: "file";
  bytes: Uint8Array;
  /** A sync access handle is open on it: the browser refuses a second one, a rename onto it and its removal. */
  locked: boolean;
};

/** An in-memory `FileSystemDirectoryHandle`, with the parts of OPFS that `BrowserFs` calls. */
export type FakeDir = ReturnType<typeof fakeDir>;

function domError(name: string, what: string): DOMException {
  return new DOMException(what, name);
}

function fakeDir(origin: FakeOrigin) {
  const children = new Map<string, FakeFile | FakeDir>();
  const fileAt = (name: string): FakeFile => {
    const node = children.get(name);
    if (node?.kind !== "file") throw domError("NotFoundError", name);
    return node;
  };

  function syncAccess(target: FakeFile) {
    let closed = false;
    const live = () => {
      if (closed) throw domError("InvalidStateError", "the access handle is closed");
    };
    return {
      truncate(size: number) {
        live();
        origin.free += target.bytes.byteLength - size;
        target.bytes = target.bytes.slice(0, size);
      },
      write(bytes: Uint8Array, { at }: { at: number }) {
        live();
        let take = bytes.byteLength;
        if (take > origin.free) {
          if (!origin.short) throw domError("QuotaExceededError", "the origin is full");
          take = Math.max(0, origin.free);
        }
        const grown = new Uint8Array(Math.max(target.bytes.byteLength, at + take));
        grown.set(target.bytes);
        grown.set(bytes.subarray(0, take), at);
        origin.free -= grown.byteLength - target.bytes.byteLength;
        target.bytes = grown;
        return take;
      },
      flush: live,
      close() {
        if (closed) return;
        closed = true;
        target.locked = false;
        origin.open -= 1;
      },
    };
  }

  const dir = {
    kind: "dir" as const,
    origin,
    children,

    /** The files under this directory, as paths, with their sizes. */
    files(prefix = ""): Record<string, number> {
      const out: Record<string, number> = {};
      for (const [name, node] of children) {
        if (node.kind === "dir") Object.assign(out, node.files(`${prefix}${name}/`));
        else out[prefix + name] = node.bytes.byteLength;
      }
      return out;
    },

    async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
      let child = children.get(name);
      if (!child && opts?.create) children.set(name, (child = fakeDir(origin)));
      if (child?.kind !== "dir") throw domError("NotFoundError", name);
      return child;
    },

    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!children.has(name) && opts?.create) children.set(name, { kind: "file", bytes: new Uint8Array(0), locked: false });
      fileAt(name);
      const handle = {
        getFile: async () => new File([fileAt(name).bytes], name),
        move: async (to: FakeDir, newName: string) => {
          const moved = fileAt(name);
          const old = to.children.get(newName);
          if (moved.locked || (old?.kind === "file" && old.locked)) throw domError("NoModificationAllowedError", newName);
          if (old?.kind === "file") origin.free += old.bytes.byteLength;
          children.delete(name);
          to.children.set(newName, moved);
          name = newName;
        },
      };
      if (origin.handles === "none") return handle;
      if (origin.handles === "writable") {
        return {
          ...handle,
          createWritable: async () => {
            const chunks: Uint8Array[] = [];
            return {
              write: async (c: Uint8Array) => void chunks.push(c),
              close: async () => void (fileAt(name).bytes = new Uint8Array(await new Blob(chunks).arrayBuffer())),
              abort: async () => undefined,
            };
          },
        };
      }
      return {
        ...handle,
        createSyncAccessHandle: async () => {
          const target = fileAt(name);
          if (origin.handles === "throws") throw domError("InvalidStateError", "no sync access handle in this context");
          if (target.locked) throw domError("NoModificationAllowedError", name);
          target.locked = true;
          origin.open += 1;
          return syncAccess(target);
        },
      };
    },

    async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
      const child = children.get(name);
      if (child === undefined) throw domError("NotFoundError", name);
      if (child.kind === "dir" && child.children.size > 0 && !opts?.recursive) throw domError("InvalidModificationError", name);
      if (child.kind === "file") {
        if (child.locked) throw domError("NoModificationAllowedError", name);
        origin.free += child.bytes.byteLength;
      }
      children.delete(name);
      origin.removals.push(name);
    },

    async *entries(): AsyncIterableIterator<[string, unknown]> {
      yield* children.entries();
    },
  };
  return dir;
}

/** A fake OPFS root in a browser whose file handles are `handles`. */
export function fakeOpfs(handles: Handles = "writable"): FakeDir {
  return fakeDir({ handles, free: Number.POSITIVE_INFINITY, short: false, removals: [], open: 0 });
}
