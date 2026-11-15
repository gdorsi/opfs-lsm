# Pages on fate and Automerge: design

A Notion-like pages app: a sidebar tree of nested pages, each with a title and a rich-text body. fate owns the tree
and the titles: the server holds them, and the device caches them and queues their writes. Automerge owns each
page's body, which stays on the device and syncs between its tabs. Both persist on one kv database
(`kvPagesStorage`), or with `?storage=idb` on IndexedDB, so the two can be compared on the same app. The bench
(`bench/workloads/pages`) drives the same model without the UI.

## Running it

```
pnpm --filter @opfs-lsm/example-pages-fate-automerge seed     # the demo tree: titles only
pnpm --filter @opfs-lsm/example-pages-fate-automerge dev      # http://127.0.0.1:4184
#   ?storage=idb   fate and bodies on IndexedDB instead of kv
#   ?db=work       another database name (default "pages")
pnpm --filter @opfs-lsm/example-pages-fate-automerge build
pnpm --filter @opfs-lsm/example-pages-fate-automerge start    # the build, with the offline shell
```

Every link keeps `?storage=` and `?db=`, so a tab never switches storage by navigating.

## The shape

The server is SQLite (`node:sqlite`) behind one fate endpoint, `POST /api/fate`. Tables (`data/pages.db`, or
`PAGES_DB`):

- `page`: `seq` (creation order), `id`, `parent_id` with `ON DELETE CASCADE`, `title`. Children are read by keyset
  on `(parent_id, seq)`.
- `receipt`: fate's mutation receipts, so a retried delivery is applied once.

`pnpm seed` writes the demo tree. A seeded page's id is derived from its title path, so a reseed keeps the bodies a
browser already holds attached to their pages.

The client is created in the browser only, in the `_app` route's loader. `src/model/` is the headless core: the
tree's fate declarations and commands (`tree.ts`) and the bodies (`bodies.ts`). It imports only fate and Automerge,
and the app, the tests and the bench all call it. Every fate view is declared in `tree.ts`, and oxlint rejects one
declared in the UI, route or client code: a production build numbers views in declaration order and persisted requests name
that number, so a view in a code-split route would change id with the order routes load in.

## The tree

Each open row asks for its children: one request per level, `children(parent, first: 200)`, whose rows read the
page's id and title. Requests are `stale-while-revalidate` and persist for 30 days, so a reload paints the sidebar
from the device and refreshes it in the background. Siblings are in creation order. Every row has a chevron, as in
Notion, because the tree keeps no child count to hold in step. Which rows are open is a viewer preference, kept in
`localStorage` per storage and database.

There are no live views. Each open level refetches when the server answers a queued mutation. The journal is
shared by the tabs, so a create, rename or delete made in one tab shows in the others when it is delivered.

## Writes

Each command is one durable fate mutation with an optimistic update, and resolves once fate stored it on the
device.

- `createPage` makes the id on the client and inserts the page at the end of its parent's cached list. When that
  list is not cached it is asked for once; with the server unreachable the page shows once the server confirms it.
  A create writes fate only: the body is seeded the first time the page opens.
- `renamePage` trims the title and caps it at 500 characters. The title field sends it on blur, on Enter or after
  1 s without a keystroke, never per keystroke, and an unchanged title sends nothing, also when the same title is
  still being stored.
- `deletePage` takes the page out of every cached list at once. The server deletes the subtree and succeeds for a
  missing id. The row menu asks before it deletes.

A refused write rolls back and stays in the footer with a Discard button. A row shows the "not synced yet" dot
while a queued mutation names its page, and the footer shows offline, server unreachable or syncing, with the count.

## Bodies

`openBodies` keeps one Automerge document per page id in a Repo over the chosen storage, with a BroadcastChannel
adapter named `pages:<storage>:<db>`, so kv tabs and idb tabs never share a body. The adapter waits 50 ms for a
peer instead of a second, so opening a page no other tab holds is not held up. The footer says that page text is
stored on this device only.

The page screen holds its body through a lease: a reference count over `open`, and a close 5 s after the last
release unless a new lease comes first. React's StrictMode remount and a quick switch back to a page reuse the open
body. On `pagehide` every open body is flushed.

## Deleted bodies

Every tab watches fate's journal and removes the bodies of pages that no longer exist. When an entry leaves the
journal:

| Entry | Last status | Meaning | Removes |
| --- | --- | --- | --- |
| `deletePage` | not failed | the server confirmed it | the page and its descendants this device has cached |
| `createPage` | failed | the refusal was discarded | the page, if it was opened |

The journal persists, so a delete confirmed after a reload or in another tab still frees its bodies. A removal
blocks the id from saving, marks an open body `removed`, drops it from memory, waits for saves in flight, then
deletes every key under the id. A screen showing a removed body says the page was deleted and makes the editor
read-only.

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

## Opening with the server unreachable

A production build registers the ServiceWorker from `examples/linearlite-fate` (see its DESIGN.md, "Opening with
the server unreachable"): it stores the page and every file of the build, including both wasm modules, and answers
the page from the cache only when the server cannot be reached. The sidebar paints the levels fate cached, a page
whose header was cached opens, and its body is editable, because bodies need no server. A level never fetched
shows the load error with Try again. The dev server registers nothing.

## Browser proof

Run it on `pnpm dev` with a seeded server, and on `pnpm build && pnpm start` for step 6. Run it once on kv and once
with `?storage=idb`. In dev, `window.__pages` holds `fate`, `bodies`, `storage` and the mounted `editor`.

1. Nested pages. Create a top-level page, a child and a grandchild. Each shows in the sidebar at once and opens.
   Collapse and expand.
2. Every block type. In the grandchild, type each rule, Tab and Shift-Tab an item through depths 0 to 5, check a
   to-do with Mod-Enter and with a click, and apply bold, italic, code and a link with their keys. Undo and redo
   all of it. After each step `docToSpans(editor.view.state.doc)` equals the open body's `spans()`.
3. Rename. No request goes out while typing a title; one rename goes out per blur, Enter or 1 s pause, and the row
   updates.
4. Reload. Text, blocks, marks, titles and the open rows are the same.
5. Two tabs. Open one page in two tabs and type in both, with Enter and Tab. Each edit reaches the other tab within
   200 ms, and the spans check passes in both.
6. Offline. On the build, open two levels and a page, stop the server and reload. The sidebar and the page paint,
   the body is editable, and a rename shows the dot until the server is back.
7. Delete. Delete the top-level page from step 1 with the grandchild open in a second tab. The subtree leaves both
   sidebars, the second tab says the page was deleted and its editor is read-only, and `storage.bodies.loadRange`
   is empty for all three ids.
8. `?storage=idb`. Repeat 1, 4 and 7. IndexedDB holds `pages-fate` and `pages-bodies`, and a kv tab and an idb tab
   on one page show different text.

## Left out

- Moving pages, a trash, search and live views.
- Body sync through a server: bodies live on each device.
- Bodies of pages deleted from another device. This device's journal never sees that delete, so their keys stay
  until a sweep that lists the stored bodies exists.

## Measured

Step 5 of the browser proof, kv, dev server: 28 edits (one per dispatch) made in one tab reached the other in 60 ms
median, 80 ms at most, and 23 edits the other way in 55 ms median, 94 ms at most, timed from `body.edit` to the other tab's remote
apply. Both documents ended equal.
