# Notes on Automerge: design

A Notion-like notes app: a sidebar tree of nested pages, each with a title and a rich-text body that shows its sub-pages
as page blocks. Everything is an
Automerge document on the device. One list doc holds the tree and the titles, and one doc per page holds its body.
The tabs of one browser sync over a BroadcastChannel; there is no server. The docs persist on one kv database
(`kvStorage` from `@opfs-lsm/automerge`).

## Running it

```
pnpm --filter @opfs-lsm/example-notes-manager-automerge dev      # http://127.0.0.1:4184
#   ?db=work       another database name (default "notes")
pnpm --filter @opfs-lsm/example-notes-manager-automerge build
pnpm --filter @opfs-lsm/example-notes-manager-automerge start    # the build, with the offline shell
```

Every link keeps `?db=`, so a tab never switches database by navigating. A new database starts with no pages.

## The shape

`openNotes` is the headless core: one Repo over the caller's storage, holding the list doc and every open body. It
imports only Automerge and automerge-repo, and oxlint rejects anything else, so the app and the Node tests both run
it unchanged. It resolves once the list doc is found or seeded and never waits on the network.

- The list doc has one fixed DocumentId in every database. A page's id is its body's DocumentId.
- Storage is one kv database named by `?db=`. Keys are automerge-repo's, `[docId, "snapshot" | "incremental", hash]`
  and `[docId, "sync-state", storageId]`, so a page's body is every key under its id. The model wraps storage in a
  filter that never closes it, tracks the saves in flight per doc and drops every save of a removed id.
- The BroadcastChannel is `notes:<db>`, so tabs on different databases never share a doc.

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
  with its title focused. The body is seeded the first time the page opens, not here. The sidebar creates top-level
  pages; a sub-page is created from its parent's body (see [Page blocks](#page-blocks)).
- `renamePage(id, title)` caps the title at 500 characters and keeps its spaces. It writes with `updateText`, so
  concurrent renames merge per character. A rename to the stored title, or of a page that is not reachable, makes no
  change. The title field renames on every keystroke with the raw value, and with the trimmed value on blur and
  Enter. While focused it shows its own text, so a rename from another tab shows once it loses focus, and its next
  keystroke writes its own text over it.
- `deletePage(id)` removes the page, its descendants and every other unreachable entry. The row menu and the removal of
  a page block ask first, and when the open page is in the subtree the app leaves it before the delete.

A change in one tab reaches the others over the BroadcastChannel, so a create, a rename or a delete shows in every
sidebar of that database. A page created in one tab under a parent another tab deletes at the same time ends hidden in
both, and its body is removed. Which rows are open is a viewer preference, kept in `localStorage` under
`notes:expanded:<db>`.

## Bodies

Each body is one Automerge doc in the same Repo. A body that storage does not hold starts at once from fixed bytes, one
change by actor `00` at time 0 holding one paragraph marker, so any two copies of a page merge; a copy another tab
holds merges in later. A stored body that cannot be read rejects the open and seeds nothing.

The page screen holds its body through a lease: a reference count over the open, and a close 5 s after the last
release unless a new lease comes first. React's StrictMode remount and a quick switch back to a page reuse the open
body. On `pagehide` the list doc and every open body are flushed.

A page that is not in the tree shows "Page not found" and never opens its body, so a deleted id is never seeded
again. A page deleted in another tab while it is open turns into the same screen.

## Page blocks

A parent's body shows each sub-page as a page block: a block marker `{ type: "page", attrs: { id } }` with no text. The
list doc owns which pages exist and under which parent; the block only places one, and shows its title live from the
list. A marker whose id is not a valid DocumentId reads as a paragraph.

- `/page` creates the page under the open one, puts its block in place of the empty line it was typed on, or after the
  line, then opens the page. A paragraph follows a page block that would end the body.
- A local change that removes a child's last block, such as Backspace on a selected block, cut or typing over it, is
  held back, and the page asks to delete the page and the pages inside it. On yes the editor applies the held change
  whole and the page deletes the pages from the list; when the body changed meanwhile, only the page blocks go.
  A change that moves a block keeps its id and asks nothing. A paste never brings a page block back, so a copy never
  places a page twice.
- The editor repairs the body, outside the undo history. On open it drops every block of a page that is not a
  reachable child and every second block of one page, and adds a block at the end for each child without one. On a
  remote change it drops second blocks, moves text a merge left after a page marker into a paragraph after it, and adds
  a paragraph when the body ends with a page block. When a child leaves the tree it drops the child's blocks. Every tab
  with the body open repairs the same way, and two tabs dropping one marker merge into one delete.
- A block whose page the tab's tree does not hold shows as "Page not found", as a block another tab created does until
  its list change arrives.

## Deleted bodies

Every tab removes the body of every id it sees that is not reachable: an id that leaves its tree, and a list entry
it cannot reach, at open and on each change. It starts each id's removal once, all in the same tick as the change, and
a failure is logged without stopping the rest. In one step a removal blocks the id from saving and from sync for the
rest of the Repo's life and detaches the Repo's copy, opened in this tab or synced from a peer. The Repo's share config
denies a blocked id to every peer, so a copy in another tab cannot write it back, and a copy that a late sync message
re-creates never leaves the tab. The removal then marks an open body `removed`, drops any copy re-created meanwhile,
waits for the saves in flight, and deletes every key under the id. It is idempotent, so every tab runs it.

## The editor

ProseMirror over a flat schema: one textblock per Automerge block marker (paragraph, heading 1 to 3, bullet and
numbered item, to-do, page), with `depth` 0 to 5 on items and to-dos instead of nested lists, and bold, italic, code and
link marks. A page block is an atom: the caret never enters it, and a click, or Enter while it is selected, opens the
page. A position maps to an Automerge index by subtracting the number of blocks before it.

- One dispatch becomes one `body.edit`, so one Automerge change. When the body refuses it, the editor stays on its
  old state and the page shows the refusal. A step type the schema cannot produce is refused the same way.
- Remote changes arrive as text edits and become one transaction that never enters the undo history. The editor
  reads the whole body once, when it opens.
- Keys: Mod-b, Mod-i and Mod-e toggle bold, italic and code. Mod-k on unlinked text opens a URL field under the
  selection (a bare host reads as https), and on a link removes it. Mod-z, Shift-Mod-z and Mod-y undo and redo.
  Tab and Shift-Tab change the depth of every item and to-do in the selection. Mod-Enter, or a click on the box,
  toggles a to-do. Mod-/ opens the block menu.
- Enter continues an item at its list and depth, and a to-do unchecked; in an empty item or to-do it moves out a
  level, then to a paragraph. Backspace at the start of a heading, item or to-do makes it a paragraph.
- Backspace at the start of the block after a page block, or Delete at the end of the block before one, selects the
  page block; an empty block goes first, unless it is the last. Enter in the title puts the caret at the top of the
  body, on a new first line when the body starts with a page block.
- Typing `# `, `## `, `### `, `- ` or `* `, `1. `, or `[] ` at the start of a block retypes it; Backspace right after
  undoes the rule.
- Typing `/` at the start of a block or after a space opens a menu: Page, Text, Heading 1 to 3, and bulleted, numbered
  and to-do lists. The text after the `/` filters it by label, or by keyword prefix. The arrow keys move, Enter or Tab
  picks, and Escape closes it and keeps the text. It closes when nothing matches or the caret leaves the block.
- Hovering a block shows a gutter beside its first line, at its indent: "+" and a handle. It follows the pointer
  between blocks, hides while typing and when the pointer leaves the editor, and does not exist on a touch-only device.
  It is one element the editor moves, so hovering changes no state and renders nothing. "+" opens a `/` menu on a new
  line below the block, or on the block when it is an empty paragraph; Escape on that menu, or a click away, takes the
  `/` back out unless a query was typed.
- The handle, or Mod-/ with the caret in a block, opens the block menu: it selects the block, drawn as a tinted row, and
  lists Turn into with the kinds of the `/` menu except Page, then Duplicate and Delete. A page block's menu is Open and
  Delete. The menu starts on the block's current kind, which is marked, and a turn into that kind changes nothing, so a
  checked to-do stays checked and an item keeps its depth. Typed letters filter by label or keyword prefix, and the keys
  are the `/` menu's. Backspace and Delete edit the filter and never reach the block. Deleting a page block asks the
  delete confirm like any other removal. Deleting the only block, or the last block when a page block is before it,
  leaves an empty paragraph.
- A block menu closes on Escape, on Mod-/, on a click elsewhere in the editor, or when another tab deletes its block.
  The selection is then put back: the caret or range it came from, the end of the block's text when the handle opened
  it, the page block itself for a page block. A click in text keeps its own caret. Another tab retyping the selected
  block, a to-do check included, leaves the block selected and the menu on it; a merge into the block above closes it.
- The menus and the delete confirm open below what they act on, or above it when more room is there, and stay inside
  the window. A menu follows its block when the page scrolls or the window resizes.
- Selection reads the same everywhere: a selected block is tinted, in a lighter tone while the editor is blurred, and a
  page block inside a text range is tinted like the text. An empty line with the caret shows "Type / for blocks".
- Numbered items count with one CSS counter per depth over consecutive blocks.

## Opening offline

The whole app runs on the device, so it works with no network. A production build registers a service worker that
stores the page and every file of the build, including both wasm modules, in a cache named after the build's file
list. It answers a file of the build from the cache, and the page from the network, falling back to the cache when
the server cannot be reached. A new build replaces the cache. The dev server registers nothing.

## Browser proof

Run it on `pnpm dev`, and on `pnpm build && pnpm start` for step 6. A new `?db=` starts empty. In dev,
`window.__notes` holds `notes`, `leases`, `storage` and the mounted `editor`.

1. Nested pages. Create a top-level page, then a child in its body with `/page`, and a grandchild the same way. Each
   opens at once with its title focused, and its sidebar row and its parent's page block show every keystroke of the
   title. Click a page block to open it. Collapse and expand.
2. Every block type. In the grandchild, type each rule, Tab and Shift-Tab an item through depths 0 to 5, check a
   to-do with Mod-Enter and with a click, and apply bold, italic, code and a link with their keys. Undo and redo
   all of it. After each step `docToSpans(editor.view.state.doc)` equals the open body's `spans()`.
3. Reload. Text, blocks, marks, titles and the open rows are the same.
4. Two tabs. Open one page in two tabs. A page created in one tab shows in the other's sidebar, and a title typed in
   one shows in the other's sidebar while it is typed. Type in both bodies, with Enter and Tab. Each edit reaches the
   other tab within 200 ms, and the spans check passes in both.
5. Delete. Delete the top-level page from step 1 with the grandchild open in a second tab. The subtree leaves both
   sidebars, the second tab shows "Page not found", and `__notes.storage.loadRange([id])` is empty for all three ids.
   A reload keeps them gone. Then select a page block and press Backspace: the page asks, and on yes the page leaves
   both sidebars and its block leaves the body in both tabs.
6. Offline. On the build, create a page and a child, type in the body, and reload once so the service worker
   controls the tab. Stop the preview server and reload. The sidebar and the page paint, the body takes edits and
   saves them, and a rename shows in the sidebar.

## Left out

- Moving pages to another parent, a trash, search and undo of a delete. The sidebar orders siblings by creation, not
  by the order of their blocks.
- Sync between devices: the notes live on one device, shared by its tabs.
- Live merging in a focused title field: it keeps its own text until it loses focus.
- A body whose page was deleted while every tab closed before removing it: its keys stay, since the list no longer
  names it. The same holds for a tab that joins in the moment before another tab that holds the body learns of the
  delete: it receives the body, keeps it in memory, passes it to every tab that joins after it, and its keys, or only
  its sync state, stay on disk.

## Measured

Step 4, dev server, headless Chrome 157 on an Apple M2 Pro, timed from one editor's DOM change to the other
editor's on one clock. Over three runs, 30 keystrokes typed 40 ms apart in one tab reached the other in 50 to 56 ms
median and 97 to 102 ms at most, and 19 keystrokes the other way in 48 to 54 ms median and 101 to 105 ms at most.
automerge-repo sends a doc's sync messages at most once per 100 ms, which bounds the wait. Both editors ended equal
in every run.
