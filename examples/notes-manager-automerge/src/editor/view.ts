import { baseKeymap } from "prosemirror-commands";
import { history } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection, Plugin, type Command, type PluginView } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView, type NodeView } from "prosemirror-view";
import type { Page, PageBody, PageId, Tree, View } from "../model/types.ts";
import { applyLocal, bodyState, remoteTransaction } from "./binding.ts";
import { pageKeymap, setLink, toggleTodo } from "./commands.ts";
import { caretAtTop, fixPages, guardPages } from "./pages.ts";
import { pageInputRules } from "./rules.ts";
import { schema } from "./schema.ts";
import { addBlock, blockMenuTarget, menuPlugin, pointMenu, runMenu, toggleBlockMenu, type Anchor, type MenuHooks } from "./menu.ts";

export type MountedEditor = {
  readonly view: EditorView;
  link(href: string | null): void;
  /** Runs item `index` of the open menu. */
  pickMenu(index: number): void;
  pointMenu(index: number): void;
  /** Focuses the body with the caret at its top. */
  focusTop(): void;
  destroy(): void;
};

type At = { readonly left: number; readonly bottom: number };

/** The pages a body's page blocks point at. The body's id is the parent of each. */
export type PageLinks = {
  readonly tree: View<Tree>;
  /** Creates a page inside this one and returns its id. */
  create(): PageId;
  open(id: PageId): void;
  /** A URL that opens the page, for a link opened in a new tab. */
  href(id: PageId): string;
};

export type EditorOptions = {
  readonly onRefused: (error: unknown) => void;
  readonly askHref: (at: At) => void;
  readonly pages: PageLinks;
  readonly onMenu: MenuHooks["show"];
  /**
   * Removing these blocks would delete their pages. On yes the page calls `confirm`, which applies the held change,
   * then deletes the pages; a change that came in since makes the editor drop the blocks when the pages go instead.
   */
  readonly askDelete: (ask: { readonly ids: readonly PageId[]; readonly at: Anchor; confirm(): void }) => void;
};

const HINT = "Type / for a page or a block, # for a heading, - for a list";

const todoCheckbox = new Plugin({
  props: {
    handleDOMEvents: {
      mousedown(view, event) {
        const check = (event.target as HTMLElement | null)?.closest?.(".todo > .check");
        if (!check || !view.editable) return false;
        event.preventDefault();
        const pos = view.posAtDOM(check.parentElement!, 0);
        return toggleTodo(view.state.doc.resolve(pos).before(1))(view.state, view.dispatch);
      },
    },
  },
});

const LINE_HINT = "Type / for blocks";

/** The empty-body hint, the hint on the empty line the caret is in, and a page block inside a text range drawn as selected. */
const decorations = new Plugin({
  props: {
    decorations({ doc, selection }) {
      const out: Decoration[] = [];
      const only = doc.firstChild!;
      if (doc.childCount === 1 && only.type === schema.nodes.paragraph && only.content.size === 0) {
        out.push(Decoration.node(0, only.nodeSize, { class: "hint", "data-hint": HINT }));
      } else if (selection.empty && selection.$head.depth === 1 && selection.$head.parent.type === schema.nodes.paragraph && selection.$head.parent.content.size === 0) {
        out.push(Decoration.node(selection.$head.before(1), selection.$head.after(1), { class: "hint-focused", "data-hint": LINE_HINT }));
      }
      if (!selection.empty && !(selection instanceof NodeSelection)) {
        const { from, to } = selection;
        doc.nodesBetween(from, to, (node, pos) => {
          if (node.type === schema.nodes.page && pos >= from && pos + node.nodeSize <= to) out.push(Decoration.node(pos, pos + node.nodeSize, { class: "in-range" }));
          return false;
        });
      }
      return out.length > 0 ? DecorationSet.create(doc, out) : null;
    },
  },
});

const SVG = "http://www.w3.org/2000/svg";

function icon(markup: string): SVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("viewBox", "0 0 18 18");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = markup;
  return svg;
}

/** The page icon on page blocks and in the menus. */
export const PAGE_ICON = ["M4.5 2.5h6l3 3v9.25a.75.75 0 0 1-.75.75h-8.25a.75.75 0 0 1-.75-.75V3.25a.75.75 0 0 1 .75-.75z", "M10.5 2.5v3h3M6.5 9h5M6.5 11.75h5"] as const;

const pageIcon = () =>
  icon(PAGE_ICON.map((d) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`).join(""));

const MOD = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? "⌘" : "Ctrl+";

const plusIcon = () => icon('<path d="M9 4v10M4 9h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>');

const gripIcon = () =>
  icon(
    [5.5, 12.5]
      .flatMap((x) => [3.5, 9, 14.5].map((y) => `<circle cx="${x}" cy="${y}" r="1.35" fill="currentColor"/>`))
      .join(""),
  );

type Pointer = { readonly x: number; readonly y: number };

/** The top-level block whose row holds the pointer's height, or null in a gap between blocks or past either end. */
function blockAt(view: EditorView, pointer: Pointer): number | null {
  const box = view.dom.getBoundingClientRect();
  if (pointer.y < box.top || pointer.y > box.bottom) return null;
  const hit = view.posAtCoords({ left: box.left + 4, top: pointer.y });
  if (!hit) return null;
  const { doc } = view.state;
  const $pos = doc.resolve(hit.inside >= 0 ? hit.inside : hit.pos);
  const start = $pos.posAtIndex(Math.min($pos.index(0), doc.childCount - 1), 0);
  const rect = (view.nodeDOM(start) as HTMLElement | null)?.getBoundingClientRect();
  return rect && pointer.y >= rect.top - 4 && pointer.y <= rect.bottom + 4 ? start : null;
}

/**
 * One gutter beside the block under the pointer, or beside the block the block menu acts on while it is open. It is
 * editor chrome, moved by `top` and `--depth`: a hover never renders React and never dispatches. "+" adds a block
 * below with a `/` menu on it, the handle opens the block menu.
 */
class BlockGutter implements PluginView {
  private readonly dom = document.createElement("div");
  private readonly handle = document.createElement("button");
  private readonly root: HTMLElement;
  private readonly view: EditorView;
  private pointer: Pointer | null = null;
  private typing = false;
  private block: number | null = null;
  private frame = 0;

  constructor(view: EditorView) {
    this.view = view;
    this.root = view.dom.parentElement!;
    const add = document.createElement("button");
    add.className = "gutter-add";
    add.setAttribute("aria-label", "Add a block below");
    add.title = "Add a block below";
    add.append(plusIcon());
    this.handle.className = "gutter-handle";
    this.handle.setAttribute("aria-label", "Open block menu");
    this.handle.title = `Open block menu (${MOD}/)`;
    this.handle.setAttribute("aria-haspopup", "listbox");
    this.handle.append(gripIcon());
    for (const button of [add, this.handle]) button.tabIndex = -1;
    this.dom.className = "gutter";
    this.dom.setAttribute("aria-hidden", "true");
    this.dom.append(add, this.handle);
    // Keeps the editor's focus and selection, so the buttons act on what the user sees.
    this.dom.addEventListener("mousedown", (event) => event.preventDefault());
    add.addEventListener("click", () => this.act(addBlock));
    this.handle.addEventListener("click", () => this.act(toggleBlockMenu));
    this.root.append(this.dom);
    this.root.addEventListener("pointermove", this.move);
    this.root.addEventListener("pointerleave", this.leave);
    view.dom.addEventListener("keydown", this.key);
  }

  update(): void {
    this.render();
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.root.removeEventListener("pointermove", this.move);
    this.root.removeEventListener("pointerleave", this.leave);
    this.view.dom.removeEventListener("keydown", this.key);
    this.dom.remove();
  }

  private act(command: (at: number) => Command): void {
    if (this.block === null) return;
    this.view.focus();
    command(this.block)(this.view.state, this.view.dispatch);
  }

  private readonly move = (event: PointerEvent): void => {
    // A touch has no hover, and a held button is a drag that selects text.
    if (event.pointerType === "touch" || event.buttons !== 0) return this.leave();
    // Chrome sends a move when content slides under a still pointer; only a real move brings the gutter back.
    if (!this.pointer || this.pointer.x !== event.clientX || this.pointer.y !== event.clientY) this.typing = false;
    this.pointer = { x: event.clientX, y: event.clientY };
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  };

  private readonly leave = (): void => {
    this.pointer = null;
    this.render();
  };

  private readonly key = (event: KeyboardEvent): void => {
    if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
    this.typing = true;
    this.render();
  };

  private render(): void {
    const { view } = this;
    const pinned = blockMenuTarget(view.state);
    this.block = pinned ?? (!this.typing && this.pointer && view.editable ? blockAt(view, this.pointer) : null);
    this.dom.classList.toggle("on", this.block !== null);
    this.dom.setAttribute("aria-hidden", String(this.block === null));
    this.handle.setAttribute("aria-expanded", String(pinned !== null));
    if (this.block === null) return;
    const node = view.state.doc.nodeAt(this.block)!;
    const row = node.type === schema.nodes.page ? (view.nodeDOM(this.block) as HTMLElement).getBoundingClientRect() : view.coordsAtPos(this.block + 1);
    this.dom.style.top = `${(row.top + row.bottom) / 2 - this.root.getBoundingClientRect().top}px`;
    this.dom.style.setProperty("--depth", String(node.attrs.depth ?? 0));
  }
}

const blockGutter = () => new Plugin({ view: (view) => new BlockGutter(view) });

/** A page block: the page's live title, a link that opens it. A block whose page is not in the tree shows as missing. */
function pageView(links: PageLinks): (node: PMNode) => NodeView {
  return (node) => {
    const dom = document.createElement("a");
    dom.className = "page-ref";
    dom.draggable = false;
    const title = document.createElement("span");
    title.className = "page-ref-title";
    title.dir = "auto";
    dom.append(pageIcon(), title);
    let id = node.attrs.id as PageId;
    let shown: Page | undefined | null = null;
    const render = () => {
      const page = links.tree.read().page(id);
      if (page === shown) return;
      shown = page;
      title.textContent = page ? page.title || "Untitled" : "Page not found";
      dom.title = page?.title ?? "";
      dom.classList.toggle("untitled", page?.title === "");
      dom.classList.toggle("missing", !page);
      if (page) dom.href = links.href(id);
      else dom.removeAttribute("href");
    };
    render();
    const stop = links.tree.subscribe(render);
    dom.addEventListener("click", (event) => {
      // A modified click opens the href in a new tab or window, as any link does.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (links.tree.read().page(id)) links.open(id);
    });
    return {
      dom,
      update(next) {
        if (next.type !== node.type) return false;
        if (next.attrs.id !== id) {
          id = next.attrs.id;
          shown = null;
          render();
        }
        return true;
      },
      ignoreMutation: () => true,
      destroy: stop,
    };
  };
}

export function mountEditor(place: HTMLElement, body: PageBody, options: EditorOptions): MountedEditor {
  const { pages } = options;
  const removed = () => body.save.read().state === "removed";
  const askHref = () => {
    const end = view.coordsAtPos(view.state.selection.to);
    options.askHref({ left: end.left, bottom: end.bottom });
  };
  const menu: MenuHooks = { createPage: pages.create, openPage: pages.open, show: options.onMenu };
  const view: EditorView = new EditorView(place, {
    state: bodyState(body, [
      menuPlugin(menu),
      pageInputRules(),
      pageKeymap(askHref, pages.open),
      keymap(baseKeymap),
      history(),
      guardPages(
        (id) => pages.tree.read().children(body.id).includes(id),
        (ids, pos, confirm) => {
          const rect = (view.nodeDOM(pos) as HTMLElement | null)?.getBoundingClientRect();
          options.askDelete({ ids, at: rect ?? { left: 0, top: 0, bottom: 0 }, confirm: () => void confirm(view.state, view.dispatch) });
        },
      ),
      todoCheckbox,
      decorations,
      blockGutter(),
    ]),
    nodeViews: { page: pageView(pages) },
    editable: () => !removed(),
    dispatchTransaction(tr) {
      try {
        view.updateState(applyLocal(body, view.state, tr));
      } catch (error) {
        options.onRefused(error);
      }
    },
  });
  const repair = (fix: Parameters<typeof fixPages>[1]) => {
    if (removed() || !pages.tree.read().page(body.id)) return;
    const tr = fixPages(view.state, fix);
    if (tr) view.dispatch(tr);
  };

  let children = pages.tree.read().children(body.id);
  repair({ children, open: true });
  const stopTree = pages.tree.subscribe(() => {
    const next = pages.tree.read().children(body.id);
    if (next === children) return;
    const gone = new Set(children.filter((id) => !next.includes(id)));
    children = next;
    if (gone.size > 0) repair({ children, gone });
  });
  const stopRemote = body.subscribe((edits) => {
    view.dispatch(remoteTransaction(view.state, edits));
    repair({ children });
  });
  // Re-reads `editable` when the body turns removed.
  const stopSave = body.save.subscribe(() => view.setProps({}));
  return {
    view,
    link(href) {
      if (href !== null) setLink(href)(view.state, view.dispatch);
      view.focus();
    },
    pickMenu(index) {
      runMenu(index, menu)(view.state, view.dispatch);
      view.focus();
    },
    pointMenu(index) {
      pointMenu(index)(view.state, view.dispatch);
    },
    focusTop() {
      if (view.editable) caretAtTop(view.state, view.dispatch);
      view.focus();
    },
    destroy() {
      stopTree();
      stopRemote();
      stopSave();
      view.destroy();
    },
  };
}
