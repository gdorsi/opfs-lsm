/**
 * The editor's menus. The `/` menu, typed at the start of a block or after a
 * space, lists what the block can become and a page to create inside this
 * one; the text after the `/` filters it. The block menu acts on one block,
 * the one a top-level block selection holds: it turns it into another kind,
 * duplicates it, deletes it, or opens a page block. One plugin holds either
 * menu and its keys, so two never show at once; the page draws it.
 */
import { NodeSelection, Plugin, PluginKey, TextSelection, type Command, type EditorState, type Selection, type SelectionBookmark, type Transaction } from "prosemirror-state";
import type { Block, PageId } from "../model/types.ts";
import { insertPageBlock } from "./pages.ts";
import { blockOf, nodeTypeOf, schema } from "./schema.ts";

/** What an item does to its block. */
export type MenuAction =
  | { readonly type: "turn"; readonly block: (current: Block) => Block }
  | { readonly type: "page" }
  | { readonly type: "open" }
  | { readonly type: "duplicate" }
  | { readonly type: "delete" };

export type MenuItem = {
  readonly label: string;
  /** The `/` menu's second line. */
  readonly hint: string;
  /** Words the query also matches by prefix. */
  readonly words: readonly string[];
  readonly action: MenuAction;
};

const depthOf = (block: Block) => ("depth" in block ? block.depth : 0);

const turn = (label: string, hint: string, words: readonly string[], block: (current: Block) => Block): MenuItem => ({ label, hint, words, action: { type: "turn", block } });

const TURN_INTO: readonly MenuItem[] = [
  turn("Text", "Plain text", ["paragraph"], () => ({ type: "paragraph" })),
  turn("Heading 1", "Big section heading", ["h1", "title"], () => ({ type: "heading", level: 1 })),
  turn("Heading 2", "Medium section heading", ["h2", "subtitle"], () => ({ type: "heading", level: 2 })),
  turn("Heading 3", "Small section heading", ["h3"], () => ({ type: "heading", level: 3 })),
  turn("Bulleted list", "A simple list", ["ul", "unordered"], (c) => ({ type: "item", list: "bullet", depth: depthOf(c) })),
  turn("Numbered list", "A list with numbers", ["ol", "ordered"], (c) => ({ type: "item", list: "number", depth: depthOf(c) })),
  turn("To-do list", "Tasks with a checkbox", ["todo", "task", "checkbox"], (c) => ({ type: "todo", depth: depthOf(c), checked: false })),
];

const PAGE: MenuItem = { label: "Page", hint: "A page inside this one", words: ["subpage", "document"], action: { type: "page" } };
const OPEN: MenuItem = { label: "Open", hint: "Go to this page", words: ["go"], action: { type: "open" } };
const DUPLICATE: MenuItem = { label: "Duplicate", hint: "A copy below", words: ["copy", "clone"], action: { type: "duplicate" } };
const DELETE: MenuItem = { label: "Delete", hint: "Remove this block", words: ["remove", "trash"], action: { type: "delete" } };

const SLASH_ITEMS: readonly MenuItem[] = [PAGE, ...TURN_INTO];
const TEXT_BLOCK_ITEMS: readonly MenuItem[] = [...TURN_INTO, DUPLICATE, DELETE];
const PAGE_BLOCK_ITEMS: readonly MenuItem[] = [OPEN, DELETE];

const itemsFor = (block: Block) => (block.type === "page" ? PAGE_BLOCK_ITEMS : TEXT_BLOCK_ITEMS);

/** What a block is for a menu: a turn into the same kind changes nothing, so a checked to-do stays checked. */
function kindOf(block: Block): string {
  switch (block.type) {
    case "heading":
      return `h${block.level}`;
    case "item":
      return block.list;
    default:
      return block.type;
  }
}

function match(items: readonly MenuItem[], query: string): readonly MenuItem[] {
  const q = query.toLowerCase();
  return items.filter((item) => item.label.toLowerCase().includes(q) || item.words.some((word) => word.startsWith(q)));
}

export type Anchor = { readonly left: number; readonly top: number; readonly bottom: number };

/** What the page draws: indexes into `items`, never a position in the document. */
export type MenuShown = {
  readonly kind: "slash" | "block";
  readonly items: readonly MenuItem[];
  readonly index: number;
  readonly query: string;
  /** The item that matches the block's current kind, or -1. */
  readonly current: number;
  readonly at: Anchor;
};

export type MenuHooks = {
  /** Creates a page inside this one and returns its id. */
  createPage(): PageId;
  openPage(id: PageId): void;
  /** The menu changed: null when it closes. */
  show(menu: MenuShown | null): void;
};

type SlashState = {
  readonly kind: "slash";
  /** The position of the `/`. */
  readonly from: number;
  readonly query: string;
  readonly items: readonly MenuItem[];
  readonly index: number;
  /** Opened by the gutter's "+", so closing it without a query takes the `/` back out. */
  readonly added: boolean;
};

type MenuState =
  | SlashState
  | {
      readonly kind: "block";
      /** The selected block. */
      readonly block: Block;
      /** The selection to put back when the menu closes, mapped through every change since it opened. */
      readonly restore: SelectionBookmark;
      readonly query: string;
      readonly items: readonly MenuItem[];
      readonly index: number;
      readonly current: number;
    };

export const menuKey = new PluginKey<MenuState | null>("menu");

type Meta =
  | { readonly close: true }
  | { readonly slash: number; readonly added: boolean }
  | { readonly block: SelectionBookmark }
  | { readonly index: number; readonly query?: string };

const CLOSE = { close: true } satisfies Meta;
const MAX_QUERY = 24;
const clamp = (index: number, count: number) => Math.max(0, Math.min(index, count - 1));

/** The `/` menu for a `/` at `from`, or null once the caret leaves its block, the `/` is gone, or nothing matches. */
function readSlash(state: EditorState, from: number, index: number, added: boolean): SlashState | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $head = selection.$head;
  if (!$head.parent.isTextblock || $head.parent.type === schema.nodes.page || from < $head.start() || from >= $head.pos) return null;
  if (state.doc.textBetween(from, from + 1) !== "/") return null;
  const query = state.doc.textBetween(from + 1, $head.pos);
  if (query.length > MAX_QUERY || /^\s/.test(query)) return null;
  const items = match(SLASH_ITEMS, query);
  if (items.length === 0) return null;
  return { kind: "slash", from, query, items, index: clamp(index, items.length), added };
}

/** The block menu, or null unless a top-level block is selected. `index` null starts on the block's current kind. */
function readBlock(state: EditorState, restore: SelectionBookmark, query: string, index: number | null): MenuState | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.$from.depth !== 0) return null;
  const block = blockOf(selection.node);
  const items = match(itemsFor(block), query);
  if (items.length === 0) return null;
  const kind = kindOf(block);
  const current = items.findIndex((item) => item.action.type === "turn" && kindOf(item.action.block(block)) === kind);
  return { kind: "block", block, restore, query, items, index: clamp(index ?? current, items.length), current };
}

/** The selection a block menu opened by the handle on `target` puts back: the caret in it, else the end of its text, else the page block itself. */
function restoreFor(state: EditorState, target: number): SelectionBookmark {
  const { selection, doc } = state;
  const node = doc.nodeAt(target)!;
  if (selection.from >= target && selection.to <= target + node.nodeSize) return selection.getBookmark();
  if (node.type === schema.nodes.page) return NodeSelection.create(doc, target).getBookmark();
  return TextSelection.create(doc, target + 1 + node.content.size).getBookmark();
}

function closeMenu(state: EditorState): Transaction {
  const menu = menuKey.getState(state);
  const tr = state.tr.setMeta(menuKey, CLOSE);
  if (menu?.kind === "block") tr.setSelection(menu.restore.resolve(state.doc));
  return tr;
}

/** The top-level block a selection selects or holds its head in, or null. */
function blockOfSelection(selection: Selection): number | null {
  if (selection instanceof NodeSelection && selection.$from.depth === 0) return selection.from;
  return selection.$head.depth >= 1 ? selection.$head.before(1) : null;
}

/**
 * Opens the block menu on the block starting at `at`, or on the selection's block when `at` is omitted, which then
 * puts the selection back as it was on close. Closes it when it is already open there. False when no block is found
 * or the `/` menu is open.
 */
export function toggleBlockMenu(at?: number): Command {
  return (state, dispatch) => {
    const { selection } = state;
    const target = at ?? blockOfSelection(selection);
    if (target === null || target > state.doc.content.size || state.doc.resolve(target).depth !== 0 || !state.doc.resolve(target).nodeAfter) return false;
    const menu = menuKey.getState(state);
    if (menu?.kind === "slash") return false;
    if (menu && selection.from === target) {
      dispatch?.(closeMenu(state));
      return true;
    }
    if (dispatch) {
      const restore = at === undefined ? selection.getBookmark() : restoreFor(state, target);
      dispatch(state.tr.setSelection(NodeSelection.create(state.doc, target)).setMeta(menuKey, { block: restore } satisfies Meta));
    }
    return true;
  };
}

/** The gutter's "+": a `/` menu on the empty paragraph at `at`, else on a new paragraph after that block. */
export function addBlock(at: number): Command {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(at);
    if (!node) return false;
    if (dispatch) {
      const tr = state.tr;
      let slash = at + 1;
      if (node.type !== schema.nodes.paragraph || node.content.size > 0) {
        tr.insert(at + node.nodeSize, schema.nodes.paragraph!.create());
        slash = at + node.nodeSize + 1;
      }
      tr.insertText("/", slash);
      dispatch(tr.setSelection(TextSelection.create(tr.doc, slash + 1)).setMeta(menuKey, { slash, added: true } satisfies Meta).scrollIntoView());
    }
    return true;
  };
}

/**
 * Runs item `index` of the open menu. The `/` menu first removes the `/` and its query. The block menu acts on
 * the selected block, read now, so a remote change since it opened is already in it, then restores the selection.
 */
export function runMenu(index: number, hooks: Pick<MenuHooks, "createPage" | "openPage">): Command {
  return (state, dispatch) => {
    const menu = menuKey.getState(state);
    const item = menu?.items[index];
    if (!menu || !item) return false;
    if (!dispatch) return true;
    const tr = state.tr.setMeta(menuKey, CLOSE);
    if (menu.kind === "slash") tr.delete(menu.from, state.selection.head);
    const at = menu.kind === "slash" ? tr.doc.resolve(menu.from).before(1) : state.selection.from;
    const node = tr.doc.nodeAt(at)!;
    let after: (() => void) | null = null;
    switch (item.action.type) {
      case "turn": {
        const current = blockOf(node);
        const next = item.action.block(current);
        if (kindOf(next) !== kindOf(current)) {
          const { type, attrs } = nodeTypeOf(next);
          tr.setNodeMarkup(at, type, attrs);
        }
        break;
      }
      case "page": {
        const id = hooks.createPage();
        insertPageBlock(tr, menu.kind === "slash" ? menu.from : at, id);
        after = () => hooks.openPage(id);
        break;
      }
      case "open": {
        const id = node.attrs.id as PageId;
        after = () => hooks.openPage(id);
        break;
      }
      case "duplicate":
        tr.insert(at + node.nodeSize, node);
        break;
      case "delete": {
        const end = at + node.nodeSize;
        const before = tr.doc.resolve(at).nodeBefore;
        // A body never ends with a page block, and never has no block.
        if (end === tr.doc.content.size && (!before || before.type === schema.nodes.page)) tr.replaceWith(at, end, schema.nodes.paragraph!.create());
        else tr.delete(at, end);
        break;
      }
    }
    if (menu.kind === "block") tr.setSelection(menu.restore.map(tr.mapping).resolve(tr.doc));
    dispatch(tr.scrollIntoView());
    after?.();
    return true;
  };
}

/** Points the menu at item `index`, as hovering does. */
export function pointMenu(index: number): Command {
  return (state, dispatch) => {
    if (!menuKey.getState(state)) return false;
    dispatch?.(state.tr.setMeta(menuKey, { index } satisfies Meta));
    return true;
  };
}

/** The start of the block the open block menu acts on, or null. */
export function blockMenuTarget(state: EditorState): number | null {
  return menuKey.getState(state)?.kind === "block" ? state.selection.from : null;
}

type BlockState = Extract<MenuState, { kind: "block" }>;

/** Adds typed text to the block menu's filter, unless nothing would match. */
function filterBlockMenu(view: { state: EditorState; dispatch(tr: Transaction): void }, menu: BlockState, text: string): void {
  const query = menu.query + text;
  if (query.length <= MAX_QUERY && match(itemsFor(menu.block), query).length > 0) view.dispatch(view.state.tr.setMeta(menuKey, { index: 0, query } satisfies Meta));
}

export function menuPlugin(hooks: MenuHooks): Plugin<MenuState | null> {
  return new Plugin<MenuState | null>({
    key: menuKey,
    state: {
      init: () => null,
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(menuKey) as Meta | undefined;
        if (meta && "close" in meta) return null;
        if (meta && "slash" in meta) return readSlash(state, meta.slash, 0, meta.added);
        if (meta && "block" in meta) return readBlock(state, meta.block, "", null);
        if (!prev) return null;
        if (!tr.docChanged && !tr.selectionSet && !meta) return prev;
        const index = meta ? meta.index : prev.index;
        if (prev.kind === "block") return readBlock(state, prev.restore.map(tr.mapping), meta?.query ?? prev.query, index);
        const next = readSlash(state, tr.mapping.map(prev.from), index, prev.added);
        if (next && !meta && next.query !== prev.query) return { ...next, index: 0 };
        return next && next.from === prev.from && next.query === prev.query && next.index === prev.index ? prev : next;
      },
    },
    // However the "+" menu closes, a `/` it typed that stands alone on its line goes with it.
    appendTransaction(trs, oldState, newState) {
      const prev = menuKey.getState(oldState);
      if (prev?.kind !== "slash" || !prev.added || menuKey.getState(newState)) return null;
      const from = trs.reduce((pos, tr) => tr.mapping.map(pos), prev.from);
      const $from = newState.doc.resolve(from);
      return $from.parentOffset === 0 && $from.parent.textContent === "/" ? newState.tr.delete(from, from + 1) : null;
    },
    props: {
      handleTextInput(view, from, to, text) {
        const menu = menuKey.getState(view.state);
        if (menu?.kind === "block") {
          filterBlockMenu(view, menu, text);
          return true;
        }
        if (text !== "/" || menu) return false;
        const $from = view.state.doc.resolve(from);
        if (!$from.parent.isTextblock || $from.parent.type === schema.nodes.page) return false;
        const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset);
        if (before !== "" && !/\s/.test(before)) return false;
        view.dispatch(view.state.tr.insertText("/", from, to).setMeta(menuKey, { slash: from, added: false } satisfies Meta));
        return true;
      },
      handleKeyDown(view, event) {
        const menu = menuKey.getState(view.state);
        if (!menu || event.isComposing) return false;
        const count = menu.items.length;
        const select = (index: number) => view.dispatch(view.state.tr.setMeta(menuKey, { index } satisfies Meta));
        switch (event.key) {
          case "ArrowDown":
            select((menu.index + 1) % count);
            return true;
          case "ArrowUp":
            select((menu.index + count - 1) % count);
            return true;
          case "Enter":
          case "Tab":
            return runMenu(menu.index, hooks)(view.state, view.dispatch);
          case "Escape":
            view.dispatch(closeMenu(view.state));
            return true;
        }
        if (menu.kind !== "block") return false;
        // The selected block must not be typed over or deleted by a key meant for the filter.
        if (event.key === "Backspace") {
          if (menu.query) view.dispatch(view.state.tr.setMeta(menuKey, { index: 0, query: menu.query.slice(0, -1) } satisfies Meta));
          return true;
        }
        return event.key === "Delete";
      },
      handleDOMEvents: {
        // Text that arrives without a key press (an input method, a virtual keyboard) must not overwrite the selected block.
        beforeinput(view, event) {
          const menu = menuKey.getState(view.state);
          if (menu?.kind !== "block" || event.isComposing) return false;
          event.preventDefault();
          if (event.inputType === "insertText" && event.data) filterBlockMenu(view, menu, event.data);
          return true;
        },
        blur(view) {
          if (menuKey.getState(view.state)) view.dispatch(closeMenu(view.state));
          return false;
        },
      },
      attributes(state): Record<string, string> {
        const menu = menuKey.getState(state);
        return menu ? { "aria-controls": "editor-menu", "aria-activedescendant": `editor-menu-${menu.index}` } : {};
      },
    },
    view(view) {
      const show = () => {
        const menu = menuKey.getState(view.state) ?? null;
        hooks.show(menu && { kind: menu.kind, items: menu.items, index: menu.index, query: menu.query, current: menu.kind === "block" ? menu.current : -1, at: anchorOf(view, menu) });
      };
      // The page draws the menu fixed to the window, so it moves with its block when the page scrolls or resizes.
      const follow = () => menuKey.getState(view.state) && show();
      const win = view.dom.ownerDocument.defaultView!;
      win.addEventListener("scroll", follow, true);
      win.addEventListener("resize", follow);
      return {
        update(view, prevState) {
          const menu = menuKey.getState(view.state) ?? null;
          if (menu !== (menuKey.getState(prevState) ?? null) || (menu && view.state.doc !== prevState.doc)) show();
        },
        destroy() {
          win.removeEventListener("scroll", follow, true);
          win.removeEventListener("resize", follow);
          hooks.show(null);
        },
      };
    },
  });
}

type Viewport = { coordsAtPos(pos: number): Anchor; nodeDOM(pos: number): Node | null; state: EditorState };

/** Where a menu sits on screen: the `/`, or the first line of the block it acts on. */
function anchorOf(view: Viewport, menu: MenuState): Anchor {
  if (menu.kind === "slash") return view.coordsAtPos(menu.from);
  const target = view.state.selection.from;
  const rect = (view.nodeDOM(target) as HTMLElement).getBoundingClientRect();
  if (menu.block.type === "page") return rect;
  const line = view.coordsAtPos(target + 1);
  return { left: rect.left, top: line.top, bottom: line.bottom };
}
