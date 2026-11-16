# Notes on Automerge: design

A Notion-like notes app: a sidebar tree of nested pages, each with a title and a rich-text body. Everything is an
Automerge document on the device. One list doc holds the tree and the titles, and one doc per page holds its body.
The tabs of one browser sync over a BroadcastChannel; there is no server. The docs persist on one kv database
(`kvStorage` from `@opfs-lsm/automerge`), or with `?storage=idb` on automerge-repo's IndexedDB adapter, so the two
can be compared on the same app. The bench (`bench/workloads/pages`) drives the same model without the UI.

## Running it

```
pnpm --filter @opfs-lsm/example-notes-manager-automerge dev      # http://127.0.0.1:4184
#   ?storage=idb   IndexedDB instead of kv
#   ?db=work       another database name (default "notes")
pnpm --filter @opfs-lsm/example-notes-manager-automerge build
pnpm --filter @opfs-lsm/example-notes-manager-automerge start    # the build, with the offline shell
```

Every link keeps `?storage=` and `?db=`, so a tab never switches storage by navigating. A new database starts with no
pages.

## The shape

`openNotes` is the headless core: one Repo over the caller's storage, holding the list doc and every open body. It
imports only Automerge and automerge-repo, and oxlint rejects anything else, so the app, the Node tests and the bench
all run it unchanged. It resolves once the list doc is found or seeded and never waits on the network.

- The list doc has one fixed DocumentId in every database. A page's id is its body's DocumentId.
- Storage is one database named by `?db=`: a kv database, or an IndexedDB database of that name. Keys are
  automerge-repo's, `[docId, "snapshot" | "incremental", hash]` and `[docId, "sync-state", storageId]`, so a page's
  body is every key under its id. The model wraps storage in a filter that never closes it, tracks the saves in
  flight per doc and drops every save of a removed id.
- The BroadcastChannel is `notes:<storage>:<db>`, so kv tabs and idb tabs never share a doc.

## The list

```ts
type ListDoc = { pages: { [id: PageId]: { parent: PageId | null; title: string; created: number } } };
```

- One flat map keyed by page id, with parent pointers. `title` is Automerge text. `created` is the time of the create
  in ms, raised to one more than the last sibling's when the clock has not moved past it.
- Siblings sort by `created`, then by id.
- A page is reachable when its parent chain ends at the top level. The sidebar and the page screen show reachable
  pages only. An entry whose parent is gone, a create that raced a delete in another tab, is unreachable for good,
  since no command brings a deleted entry back: it is hidden and treated as deleted.
- The list starts from fixed bytes: one change by actor `00` at time 0 that sets `pages = {}`. Two tabs that each
  seed an empty database make the same change, so their pages merge, which is why `pages` is never created any other
  way. When storage cannot read the list, the model refuses to open rather than seed over it.
- Each change to the list doc rebuilds the tree, which keeps every level array and page object that did not change.
  The sidebar subscribes per level and per row, so typing a title re-renders that row and the page header only.

Each command is synchronous and one change:

- `createPage(parent)` adds an entry with an empty title at the end of the parent's level. The app then opens the page
  with its title focused. The body is seeded the first time the page opens, not here.
- `renamePage(id, title)` caps the title at 500 characters and keeps its spaces. It writes with `updateText`, so
  concurrent renames merge per character. A rename to the stored title, or of a page that is not reachable, makes no
  change. The title field renames on every keystroke with the raw value, and with the trimmed value on blur and
  Enter. While focused it shows its own text, so a rename from another tab shows once it loses focus, and its next
  keystroke writes its own text over it.
- `deletePage(id)` removes the page, its descendants and every other unreachable entry. The row menu asks first, and
  when the open page is in the subtree the app leaves it before the delete.

A change in one tab reaches the others over the BroadcastChannel, so a create, a rename or a delete shows in every
sidebar of that database. A page created in one tab under a parent another tab deletes at the same time ends hidden in
both, and its body is removed. Which rows are open is a viewer preference, kept in `localStorage` under
`notes:expanded:<storage>:<db>`.

## Bodies

Each body is one Automerge doc in the same Repo. A body that storage does not hold starts at once from fixed bytes, one
change by actor `00` at time 0 holding one paragraph marker, so any two copies of a page merge; a copy another tab
holds merges in later. A stored body that cannot be read rejects the open and seeds nothing.

The page screen holds its body through a lease: a reference count over the open, and a close 5 s after the last
release unless a new lease comes first. React's StrictMode remount and a quick switch back to a page reuse the open
body. On `pagehide` the list doc and every open body are flushed.

A page that is not in the tree shows "Page not found" and never opens its body, so a deleted id is never seeded
again. A page deleted in another tab while it is open turns into the same screen.

## Deleted bodies

Every tab removes the body of every id it sees that is not reachable: an id that leaves its tree, and a list entry
it cannot reach, at open and on each change. It removes each id once, one at a time, and a failure is logged without
stopping the rest. A removal blocks the id from saving for the rest of the Repo's life, so a copy in another tab
cannot write it back, marks an open body `removed`, drops every copy the Repo holds, opened in this tab or synced from
a peer, so no tab that joins later receives it, waits for the saves in flight, then deletes every key under the id.
It is idempotent, so every tab runs it.

## The editor

ProseMirror over a flat schema: one textblock per Automerge block marker (paragraph, heading 1 to 3, bullet and
numbered item, to-do), with `depth` 0 to 5 on items and to-dos instead of nested lists, and bold, italic, code and
link marks. A position maps to an Automerge index by subtracting the number of blocks before it.

- One dispatch becomes one `body.edit`, so one Automerge change. When the body refuses it, the editor stays on its
  old state and the page shows the refusal. A step type the schema cannot produce is refused the same way.
- Remote changes arrive as text edits and become one transaction that never enters the undo history. The editor
  reads the whole body once, when it opens.
- Keys: Mod-b, Mod-i and Mod-e toggle bold, italic and code. Mod-k on unlinked text opens a URL field under the
  selection (a bare host reads as https), and on a link removes it. Mod-z, Shift-Mod-z and Mod-y undo and redo.
  Tab and Shift-Tab change the depth of every item and to-do in the selection. Mod-Enter, or a click on the box,
  toggles a to-do.
- Enter continues an item at its list and depth, and a to-do unchecked; in an empty item or to-do it moves out a
  level, then to a paragraph. Backspace at the start of a heading, item or to-do makes it a paragraph.
- Typing `# `, `## `, `### `, `- ` or `* `, `1. `, or `[] ` at the start of a block retypes it; Backspace right after
  undoes the rule.
- Numbered items count with one CSS counter per depth over consecutive blocks.

## Opening offline

The whole app runs on the device, so it works with no network. A production build registers a service worker that
stores the page and every file of the build, including both wasm modules, in a cache named after the build's file
list. It answers a file of the build from the cache, and the page from the network, falling back to the cache when
the server cannot be reached. A new build replaces the cache. The dev server registers nothing.

## Browser proof

Run it on `pnpm dev`, and on `pnpm build && pnpm start` for step 6. Run it once on kv and once with `?storage=idb`. A
new `?db=` starts empty. In dev, `window.__notes` holds `notes`, `leases`, `storage` and the mounted `editor`.

1. Nested pages. Create a top-level page, a child and a grandchild. Each opens at once with its title focused, and
   its sidebar row shows every keystroke of the title. Collapse and expand.
2. Every block type. In the grandchild, type each rule, Tab and Shift-Tab an item through depths 0 to 5, check a
   to-do with Mod-Enter and with a click, and apply bold, italic, code and a link with their keys. Undo and redo
   all of it. After each step `docToSpans(editor.view.state.doc)` equals the open body's `spans()`.
3. Reload. Text, blocks, marks, titles and the open rows are the same.
4. Two tabs. Open one page in two tabs. A page created in one tab shows in the other's sidebar, and a title typed in
   one shows in the other's sidebar while it is typed. Type in both bodies, with Enter and Tab. Each edit reaches the
   other tab within 200 ms, and the spans check passes in both.
5. Delete. Delete the top-level page from step 1 with the grandchild open in a second tab. The subtree leaves both
   sidebars, the second tab shows "Page not found", and `__notes.storage.loadRange([id])` is empty for all three ids.
   A reload keeps them gone.
6. Offline. On the build, create a page and a child, type in the body, and reload once so the service worker
   controls the tab. Stop the preview server and reload. The sidebar and the page paint, the body takes edits and
   saves them, and a rename shows in the sidebar.
7. `?storage=idb`. Repeat 1, 3 and 5. IndexedDB holds one database named by `?db=`, and a kv tab and an idb tab with
   the same `?db=` show different pages.

## Left out

- Moving pages, a trash, search and undo of a delete.
- Sync between devices: the notes live on one device, shared by its tabs.
- Live merging in a focused title field: it keeps its own text until it loses focus.
- A body whose page was deleted while every tab closed before removing it: its keys stay, since the list no longer
  names it.

## Measured

Step 4 on kv, dev server, headless Chrome 157 on an Apple M2 Pro, timed from one editor's DOM change to the other
editor's on one clock. Over three runs, 30 keystrokes typed 40 ms apart in one tab reached the other in 50 to 56 ms
median and 97 to 102 ms at most, and 19 keystrokes the other way in 48 to 54 ms median and 101 to 105 ms at most. One
run on IndexedDB gave 48 ms median both ways, 95 and 98 ms at most. automerge-repo sends a doc's sync messages at most
once per 100 ms, which bounds the wait. Both editors ended equal in every run.
